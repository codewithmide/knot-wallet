import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { authMiddleware } from "../auth/middleware.js";
import { transferSOL, transferSPLToken } from "../actions/transfer.js";
import { trade } from "../actions/trade.js";
import { signMessage, devnetConnection } from "../turnkey/signer.js";
import { signExternalTransaction } from "../actions/simulate.js";
import { getBalances } from "../utils/balances.js";
import { exportWalletPrivateKey, exportWalletSeedPhrase } from "../actions/export.js";
import { simulateTransaction } from "../turnkey/signer.js";
import { VersionedTransaction, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { config } from "../config.js";
import { db } from "../db/prisma.js";
import { success, error } from "../utils/response.js";
import { resolveTokenMint, TokenNotFoundError } from "../utils/tokens.js";

const actions = new Hono();

// All action routes require authentication
actions.use("*", authMiddleware);

// GET /wallets/me/balances
actions.get("/balances", async (c) => {
  const agent = c.get("agent");
  const balances = await getBalances(agent.solanaAddress);
  return success(c, "Balances retrieved successfully.", balances);
});

// GET /wallets/me/history
// Get transaction history from audit log
actions.get("/history", async (c) => {
  const agent = c.get("agent");
  const limit = Math.min(parseInt(c.req.query("limit") || "50"), 100);
  const offset = parseInt(c.req.query("offset") || "0");
  const action = c.req.query("action"); // Optional filter: transfer, trade, sign_message, etc.

  const where: { agentId: string; action?: string } = { agentId: agent.id };
  if (action) {
    where.action = action;
  }

  const [transactions, total] = await Promise.all([
    db.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      select: {
        id: true,
        action: true,
        asset: true,
        amount: true,
        to: true,
        signature: true,
        status: true,
        metadata: true,
        createdAt: true,
      },
    }),
    db.auditLog.count({ where }),
  ]);

  return success(c, "Transaction history retrieved.", {
    transactions,
    pagination: {
      total,
      limit,
      offset,
      hasMore: offset + transactions.length < total,
    },
  });
});

// POST /wallets/me/actions/transfer
// Transfer native SOL or any SPL token
// Supports: symbol (e.g., "USDC") or mint address
actions.post(
  "/actions/transfer",
  zValidator(
    "json",
    z.object({
      to: z.string().min(32).max(44),
      amount: z.number().positive(),
      mint: z.string().min(1).optional(), // Symbol (e.g., "USDC") or mint address (omit for SOL)
    })
  ),
  async (c) => {
    const agent = c.get("agent");
    const { to, amount, mint } = c.req.valid("json");

    // If no mint provided, transfer native SOL
    if (!mint) {
      const result = await transferSOL(agent.solanaAddress, to, amount, agent.id, agent.turnkeySubOrgId);
      return success(c, "SOL transfer completed successfully.", result);
    }

    // Resolve symbol or mint address
    // - If mint address: use directly
    // - If symbol: check local directory, then Jupiter API (verified only)
    try {
      const resolved = await resolveTokenMint(mint);
      const result = await transferSPLToken(
        agent.solanaAddress,
        to,
        resolved.mint,
        amount,
        agent.id,
        agent.turnkeySubOrgId
      );

      const assetName = resolved.symbol !== "Unknown"
        ? resolved.symbol
        : `SPL token (${resolved.mint.slice(0, 8)}...)`;

      return success(c, `${assetName} transfer completed successfully.`, result);
    } catch (err) {
      if (err instanceof TokenNotFoundError) {
        return error(c, err.message, 400);
      }
      throw err;
    }
  }
);

// POST /wallets/me/actions/trade
actions.post(
  "/actions/trade",
  zValidator(
    "json",
    z.object({
      from: z.string(), // "USDC" or mint address
      to: z.string(), // "SOL" or mint address
      amount: z.number().positive(),
      slippageBps: z.number().int().min(1).max(5000).default(50),
    })
  ),
  async (c) => {
    const agent = c.get("agent");
    const { from, to, amount, slippageBps } = c.req.valid("json");

    const result = await trade(
      agent.solanaAddress,
      agent.id,
      agent.turnkeySubOrgId,
      from,
      to,
      amount,
      slippageBps
    );

    return success(c, "Trade executed successfully.", result);
  }
);

// POST /wallets/me/actions/sign-message
actions.post(
  "/actions/sign-message",
  zValidator("json", z.object({ message: z.string().min(1) })),
  async (c) => {
    const agent = c.get("agent");
    const { message } = c.req.valid("json");

    const signature = await signMessage(message, agent.solanaAddress, agent.turnkeySubOrgId);

    // Log message signing
    await db.auditLog.create({
      data: {
        agentId: agent.id,
        action: "sign_message",
        status: "confirmed",
        metadata: { messageLength: message.length },
      },
    });

    return success(c, "Message signed successfully.", {
      signature,
      signerAddress: agent.solanaAddress,
    });
  }
);

// POST /wallets/me/actions/sign-tx
// For when an external protocol sends a transaction for the agent to sign
actions.post(
  "/actions/sign-tx",
  zValidator(
    "json",
    z.object({
      transaction: z.string(), // base64 serialized VersionedTransaction
    })
  ),
  async (c) => {
    const agent = c.get("agent");
    const { transaction } = c.req.valid("json");

    const result = await signExternalTransaction(
      transaction,
      agent.solanaAddress,
      agent.id,
      agent.turnkeySubOrgId
    );

    return success(c, "Transaction signed and broadcast successfully.", result);
  }
);

// POST /wallets/me/actions/simulate
// Dry-run: understand a transaction without signing
actions.post(
  "/actions/simulate",
  zValidator("json", z.object({ transaction: z.string() })),
  async (c) => {
    const { transaction } = c.req.valid("json");
    const txBytes = Buffer.from(transaction, "base64");
    const tx = VersionedTransaction.deserialize(txBytes);

    const result = await simulateTransaction(tx);

    if (result.success) {
      return success(c, "Transaction simulation completed.", result);
    } else {
      return error(c, "Transaction simulation failed.", 400, result);
    }
  }
);

// POST /wallets/me/actions/faucet-sol
// Devnet only — request test SOL
actions.post("/actions/faucet-sol", async (c) => {
  const agent = c.get("agent");

  if (config.SOLANA_NETWORK !== "devnet") {
    return error(c, "Faucet only available on devnet.", 400);
  }

  const sig = await devnetConnection.requestAirdrop(
    new PublicKey(agent.solanaAddress),
    0.1 * LAMPORTS_PER_SOL
  );

  return success(c, "Airdrop requested successfully.", {
    signature: sig,
    amount: "0.1 SOL (devnet)",
  });
});

// POST /wallets/me/actions/export-private-key
// Export the Solana private key for this wallet
actions.post("/actions/export-private-key", async (c) => {
  const agent = c.get("agent");

  const result = await exportWalletPrivateKey(
    agent.solanaAddress,
    agent.turnkeySubOrgId
  );

  // Log the export action
  await db.auditLog.create({
    data: {
      agentId: agent.id,
      action: "export_private_key",
      status: "confirmed",
      metadata: { address: agent.solanaAddress },
    },
  });

  return success(c, "Private key exported successfully. Keep it secure.", {
    ...result,
    warning: "Keep this private key secure. Never share it with anyone.",
  });
});

// POST /wallets/me/actions/export-seed-phrase
// Export the wallet seed phrase (mnemonic)
actions.post("/actions/export-seed-phrase", async (c) => {
  const agent = c.get("agent");

  const result = await exportWalletSeedPhrase(
    agent.turnkeyWalletId,
    agent.turnkeySubOrgId
  );

  // Log the export action
  await db.auditLog.create({
    data: {
      agentId: agent.id,
      action: "export_seed_phrase",
      status: "confirmed",
      metadata: { walletId: agent.turnkeyWalletId },
    },
  });

  return success(c, "Seed phrase exported successfully. Keep it secure.", {
    ...result,
    warning: "Keep this seed phrase secure. Never share it with anyone.",
  });
});

export { actions };
