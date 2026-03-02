import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { authMiddleware } from "../auth/middleware.js";
import { transferSOL, transferSPLToken } from "../actions/transfer.js";
import { trade } from "../actions/trade.js";
import { getBalances } from "../utils/balances.js";
import {
  listPools,
  getPoolInfo,
  getAgentPositions,
  getPositionDetails,
  addLiquidity,
  removeLiquidity,
  claimRewards,
  retryPendingWithdrawal,
  isMeteoraAdminConfigured,
} from "../services/liquidity.js";
import { db } from "../db/prisma.js";
import { success, error } from "../utils/response.js";
import { resolveTokenMint, TokenNotFoundError } from "../utils/tokens.js";
import { createAuditLog } from "../utils/audit.js";
import { agentActionRateLimit } from "../utils/rate-limit.js";
import { idempotency } from "../utils/idempotency.js";

const actions = new Hono();

// All action routes require authentication, then rate-limit per agent
actions.use("*", authMiddleware);
actions.use("*", agentActionRateLimit);

// Idempotency protection on all POST (mutation) routes
// Clients can send an `Idempotency-Key` header to prevent duplicate executions
actions.use("/actions/*", idempotency);

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

// POST /wallets/me/actions/unwrap-sol
// Unwrap wSOL back to native SOL (closes wSOL token account)
actions.post(
  "/actions/unwrap-sol",
  zValidator(
    "json",
    z.object({
      amount: z.number().positive().optional(), // Optional: unwrap specific amount, default = all
    })
  ),
  async (c) => {
    const agent = c.get("agent");
    const { amount } = c.req.valid("json");

    const {
      PublicKey,
      VersionedTransaction,
      TransactionMessage,
      LAMPORTS_PER_SOL,
    } = await import("@solana/web3.js");
    const {
      getAssociatedTokenAddress,
      createCloseAccountInstruction,
      getAccount,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID,
    } = await import("@solana/spl-token");
    const { connection, signAndBroadcast } = await import("../turnkey/signer.js");

    const userPubkey = new PublicKey(agent.solanaAddress);
    const wsolAccount = await getAssociatedTokenAddress(
      NATIVE_MINT,
      userPubkey,
      false,
      TOKEN_PROGRAM_ID
    );

    // Check if wSOL account exists
    let accountInfo;
    try {
      accountInfo = await getAccount(connection, wsolAccount, undefined, TOKEN_PROGRAM_ID);
    } catch (err) {
      return error(c, "No wSOL account found. You don't have any wrapped SOL to unwrap.", 400);
    }

    const wsolBalance = Number(accountInfo.amount) / LAMPORTS_PER_SOL;

    if (wsolBalance === 0) {
      return error(c, "wSOL balance is zero. Nothing to unwrap.", 400);
    }

    // If amount specified, validate it
    if (amount !== undefined && amount > wsolBalance) {
      return error(
        c,
        `Insufficient wSOL balance. Have ${wsolBalance} wSOL, requested ${amount} wSOL.`,
        400
      );
    }

    const unwrapAmount = amount ?? wsolBalance;

    const { blockhash } = await connection.getLatestBlockhash();
    const instructions = [];

    // Close wSOL account - unwraps to native SOL
    instructions.push(
      createCloseAccountInstruction(
        wsolAccount,
        userPubkey,      // destination for unwrapped SOL
        userPubkey,      // account owner
        [],
        TOKEN_PROGRAM_ID
      )
    );

    const message = new TransactionMessage({
      payerKey: userPubkey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(message);
    const signature = await signAndBroadcast(
      transaction,
      agent.solanaAddress,
      agent.turnkeySubOrgId
    );

    await createAuditLog({
      agentId: agent.id,
      action: "unwrap_sol",
      asset: "SOL",
      amount: unwrapAmount,
      signature,
      status: "confirmed",
      metadata: {
        wsolAmount: unwrapAmount,
        unwrappedToNativeSol: true,
      },
    });

    return success(c, `Successfully unwrapped ${unwrapAmount} wSOL to native SOL.`, {
      signature,
      amount: unwrapAmount,
      explorerUrl: `https://solscan.io/tx/${signature}`,
    });
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

// ============================================================================
// Liquidity Provision (Meteora DLMM)
// ============================================================================

// GET /wallets/me/pools
// List available DLMM pools
actions.get("/pools", async (c) => {
  const tokenX = c.req.query("tokenX");
  const tokenY = c.req.query("tokenY");
  const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!) : 50;

  const pools = await listPools({ tokenX, tokenY, limit });
  return success(c, "Pools retrieved successfully.", { pools });
});

// GET /wallets/me/pools/:address
// Get detailed info about a specific pool
actions.get("/pools/:address", async (c) => {
  const address = c.req.param("address");
  const poolInfo = await getPoolInfo(address);
  return success(c, "Pool info retrieved successfully.", poolInfo);
});

// GET /wallets/me/positions
// Get user's LP positions (from database - custodial)
actions.get("/positions", async (c) => {
  const agent = c.get("agent");
  const status = c.req.query("status"); // "active", "closed", or omit for all

  if (!isMeteoraAdminConfigured()) {
    return error(c, "Liquidity provision is not configured", 503);
  }

  const positions = await getAgentPositions(agent.id, status ? { status } : undefined);
  return success(c, "Positions retrieved successfully.", { positions });
});

// GET /wallets/me/positions/:positionId
// Get detailed position info including on-chain data and pending rewards
// Use this to check if there are rewards to claim
actions.get("/positions/:positionId", async (c) => {
  const agent = c.get("agent");
  const positionId = c.req.param("positionId");

  if (!isMeteoraAdminConfigured()) {
    return error(c, "Liquidity provision is not configured", 503);
  }

  try {
    const details = await getPositionDetails(agent.id, positionId);
    return success(c, "Position details retrieved successfully.", details);
  } catch (err) {
    if (err instanceof Error && err.message.includes("not found")) {
      return error(c, err.message, 404);
    }
    throw err;
  }
});

// POST /wallets/me/actions/add-liquidity
// Add liquidity to a DLMM pool (custodial: agent transfers tokens to admin, admin provides liquidity)
// Supports one-sided liquidity:
//   - amountX > 0, amountY = 0: One-sided X (bins above active price, selling X at higher prices)
//   - amountX = 0, amountY > 0: One-sided Y (bins below active price, buying X at lower prices)
//   - Both positive: Two-sided liquidity around active price
actions.post(
  "/actions/add-liquidity",
  zValidator(
    "json",
    z.object({
      pool: z.string().min(32).max(44),
      amountX: z.number().nonnegative(), // Allow 0 for one-sided Y
      amountY: z.number().nonnegative().optional(), // Allow 0 for one-sided X
      strategy: z.enum(["spot", "curve", "bidAsk"]).default("spot"),
      rangeWidth: z.number().int().min(1).max(100).default(10),
    }).refine(
      (data) => data.amountX > 0 || (data.amountY !== undefined && data.amountY > 0),
      { message: "At least one of amountX or amountY must be positive" }
    )
  ),
  async (c) => {
    const agent = c.get("agent");
    const { pool, amountX, amountY, strategy, rangeWidth } = c.req.valid("json");

    if (!isMeteoraAdminConfigured()) {
      return error(c, "Liquidity provision is not configured", 503);
    }

    const result = await addLiquidity(
      agent.id,
      agent.solanaAddress,
      agent.turnkeySubOrgId,
      pool,
      amountX,
      amountY,
      strategy,
      rangeWidth
    );

    // Customize message based on liquidity type
    const isOneSidedX = amountX > 0 && amountY === 0;
    const isOneSidedY = amountX === 0 && amountY !== undefined && amountY > 0;
    const feeMsg = `A ${result.entryFeeBps / 100}% + $${result.flatFeeUsd.toFixed(2)} entry fee was charged (total: $${result.totalFeeUsd.toFixed(2)}).`;
    let message = `Liquidity added successfully. ${feeMsg}`;
    if (isOneSidedX) {
      message = `One-sided liquidity (X only) added successfully. Bins are above active price. ${feeMsg}`;
    } else if (isOneSidedY) {
      message = `One-sided liquidity (Y only) added successfully. Bins are below active price. ${feeMsg}`;
    }

    return success(c, message, result);
  }
);

// POST /wallets/me/actions/remove-liquidity
// Remove liquidity from a DLMM position (custodial: admin removes, deducts 1% fee, transfers to agent)
actions.post(
  "/actions/remove-liquidity",
  zValidator(
    "json",
    z.object({
      positionId: z.string().uuid(), // Database position ID (not on-chain pubkey)
      percentage: z.number().int().min(1).max(100).default(100),
    })
  ),
  async (c) => {
    const agent = c.get("agent");
    const { positionId, percentage } = c.req.valid("json");

    if (!isMeteoraAdminConfigured()) {
      return error(c, "Liquidity provision is not configured", 503);
    }

    const result = await removeLiquidity(
      agent.id,
      agent.solanaAddress,
      positionId,
      percentage
    );

    return success(c, "Liquidity removed successfully. A 1% exit fee was deducted.", result);
  }
);

// POST /wallets/me/actions/claim-rewards
// Claim fees and rewards from a DLMM position (custodial: admin claims, deducts 1% platform fee, transfers to agent)
actions.post(
  "/actions/claim-rewards",
  zValidator(
    "json",
    z.object({
      positionId: z.string().uuid(), // Database position ID (not on-chain pubkey)
    })
  ),
  async (c) => {
    const agent = c.get("agent");
    const { positionId } = c.req.valid("json");

    if (!isMeteoraAdminConfigured()) {
      return error(c, "Liquidity provision is not configured", 503);
    }

    const result = await claimRewards(
      agent.id,
      agent.solanaAddress,
      positionId
    );

    return success(c, "Rewards claimed successfully. A 1% platform fee was deducted.", result);
  }
);

// POST /wallets/me/actions/retry-withdrawal
// Retry withdrawal for a position that was removed on-chain but transfer failed
actions.post(
  "/actions/retry-withdrawal",
  zValidator(
    "json",
    z.object({
      positionId: z.string().uuid(), // Database position ID
    })
  ),
  async (c) => {
    const agent = c.get("agent");
    const { positionId } = c.req.valid("json");

    if (!isMeteoraAdminConfigured()) {
      return error(c, "Liquidity provision is not configured", 503);
    }

    const result = await retryPendingWithdrawal(
      agent.id,
      agent.solanaAddress,
      positionId
    );

    return success(
      c,
      "Withdrawal completed successfully. Your funds have been transferred.",
      result
    );
  }
);

export { actions };
