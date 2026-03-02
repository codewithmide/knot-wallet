import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "../../db/prisma.js";
import { config } from "../../config.js";
import { error, success } from "../../utils/response.js";
import { connection, signAndBroadcastAdmin, signTransactionAdmin } from "../../turnkey/signer.js";
import {
  PublicKey,
  SystemProgram,
  VersionedTransaction,
  TransactionMessage,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  getAccount,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getMint,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import { USDC_MINT } from "./auth.js";
import { resolveTokenMint } from "../../utils/tokens.js";
import { createAuditLog } from "../../utils/audit.js";
import { logger } from "../../utils/logger.js";
import { kalshiRequest, type BalanceResponse } from "../../kalshi/client.js";

const walletRoutes = new Hono();

// Jupiter Ultra API for admin swaps
const JUPITER_ULTRA_API = "https://api.jup.ag/ultra/v1";

// Helper to get admin wallet config
type AdminWalletType = "kalshi" | "meteora";

function getAdminWallet(walletType: AdminWalletType): { address: string; keyId: string } | null {
  if (walletType === "kalshi") {
    if (!config.KNOT_KALSHI_ADMIN_WALLET_ADDRESS || !config.KNOT_KALSHI_ADMIN_KEY_ID) {
      return null;
    }
    return {
      address: config.KNOT_KALSHI_ADMIN_WALLET_ADDRESS,
      keyId: config.KNOT_KALSHI_ADMIN_KEY_ID,
    };
  } else if (walletType === "meteora") {
    if (!config.KNOT_METEORA_ADMIN_WALLET_ADDRESS || !config.KNOT_METEORA_ADMIN_KEY_ID) {
      return null;
    }
    return {
      address: config.KNOT_METEORA_ADMIN_WALLET_ADDRESS,
      keyId: config.KNOT_METEORA_ADMIN_KEY_ID,
    };
  }
  return null;
}

// =============================================================================
// Transfer
// =============================================================================

// POST /wallet/transfer
walletRoutes.post(
  "/transfer",
  zValidator(
    "json",
    z.object({
      wallet: z.enum(["kalshi", "meteora"]),
      to: z.string().min(32).max(44),
      amount: z.number().positive(),
      mint: z.string().optional(), // If not provided, transfers SOL
    })
  ),
  async (c) => {
    const { wallet: walletType, to, amount, mint } = c.req.valid("json");
    const adminEmail = (c.get as (key: string) => string | undefined)("adminEmail") || "unknown";

    logger.info("Admin transfer requested", { walletType, to, amount, mint, adminEmail });

    try {
      const adminWallet = getAdminWallet(walletType);
      if (!adminWallet) {
        return error(c, `Admin wallet '${walletType}' is not configured.`, 503);
      }

      const fromAddress = adminWallet.address;
      const fromPubkey = new PublicKey(fromAddress);
      const toPubkey = new PublicKey(to);

      let signature: string;
      let assetLabel: string;

      if (!mint || mint.toUpperCase() === "SOL") {
        // Transfer native SOL
        const lamports = Math.floor(amount * LAMPORTS_PER_SOL);

        // Verify balance
        const balance = await connection.getBalance(fromPubkey);
        const estimatedFee = 10_000;
        if (balance < lamports + estimatedFee) {
          return error(
            c,
            `Insufficient SOL balance. Have ${balance / LAMPORTS_PER_SOL} SOL, need ${(lamports + estimatedFee) / LAMPORTS_PER_SOL} SOL.`,
            400
          );
        }

        const { blockhash } = await connection.getLatestBlockhash();
        const message = new TransactionMessage({
          payerKey: fromPubkey,
          recentBlockhash: blockhash,
          instructions: [
            SystemProgram.transfer({ fromPubkey, toPubkey, lamports }),
          ],
        }).compileToV0Message();

        const transaction = new VersionedTransaction(message);
        signature = await signAndBroadcastAdmin(transaction, fromAddress);
        assetLabel = "SOL";

      } else {
        // Transfer SPL token
        const mintPubkey = new PublicKey(mint);

        // Detect token program
        let tokenProgramId = TOKEN_PROGRAM_ID;
        let mintInfo;
        try {
          mintInfo = await getMint(connection, mintPubkey);
        } catch (err) {
          if (err instanceof Error && err.name === "TokenInvalidAccountOwnerError") {
            mintInfo = await getMint(connection, mintPubkey, undefined, TOKEN_2022_PROGRAM_ID);
            tokenProgramId = TOKEN_2022_PROGRAM_ID;
          } else {
            throw err;
          }
        }

        const decimals = mintInfo.decimals;
        const rawAmount = Math.floor(amount * Math.pow(10, decimals));

        const fromTokenAccount = await getAssociatedTokenAddress(
          mintPubkey, fromPubkey, false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID
        );
        const toTokenAccount = await getAssociatedTokenAddress(
          mintPubkey, toPubkey, false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID
        );

        // Verify balance
        try {
          const accountInfo = await getAccount(connection, fromTokenAccount, undefined, tokenProgramId);
          if (Number(accountInfo.amount) < rawAmount) {
            return error(
              c,
              `Insufficient token balance. Have ${Number(accountInfo.amount) / Math.pow(10, decimals)}, need ${amount}.`,
              400
            );
          }
        } catch (err) {
          if ((err as Error).name === "TokenAccountNotFoundError") {
            return error(c, `No token account found for mint ${mint}. Balance is 0.`, 400);
          }
          throw err;
        }

        const { blockhash } = await connection.getLatestBlockhash();
        const instructions = [];

        // Create recipient token account if needed
        const toAccountInfo = await connection.getAccountInfo(toTokenAccount);
        if (!toAccountInfo) {
          instructions.push(
            createAssociatedTokenAccountInstruction(
              fromPubkey, toTokenAccount, toPubkey, mintPubkey, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID
            )
          );
        }

        instructions.push(
          createTransferCheckedInstruction(
            fromTokenAccount, mintPubkey, toTokenAccount, fromPubkey, rawAmount, decimals, [], tokenProgramId
          )
        );

        const message = new TransactionMessage({
          payerKey: fromPubkey,
          recentBlockhash: blockhash,
          instructions,
        }).compileToV0Message();

        const transaction = new VersionedTransaction(message);
        signature = await signAndBroadcastAdmin(transaction, fromAddress);
        assetLabel = mint;
      }

      logger.info("Admin transfer completed", {
        signature,
        walletType,
        asset: assetLabel,
        amount,
        from: fromAddress,
        to,
        adminEmail,
        noFee: true,
      });

      // Log admin action to audit log (agentId is null for admin actions)
      await createAuditLog({
        agentId: null,
        action: "admin_transfer",
        asset: assetLabel,
        amount,
        from: fromAddress,
        to,
        signature,
        status: "confirmed",
        metadata: {
          walletType,
          adminEmail,
          noFee: true,
        },
      });

      return success(c, "Admin transfer completed.", {
        signature,
        explorerUrl: `https://solscan.io/tx/${signature}`,
        from: fromAddress,
        to,
        amount,
        asset: assetLabel,
        fee: 0,
        note: "No platform fee (admin transfer)",
      });
    } catch (err) {
      logger.error("Admin transfer failed", { error: String(err), walletType, to, amount });
      return error(c, `Transfer failed: ${String(err)}`, 500);
    }
  }
);

// =============================================================================
// Swap
// =============================================================================

// POST /wallet/swap
walletRoutes.post(
  "/swap",
  zValidator(
    "json",
    z.object({
      wallet: z.enum(["kalshi", "meteora"]),
      from: z.string(), // Token symbol or mint address
      to: z.string(), // Token symbol or mint address
      amount: z.number().positive(),
      slippageBps: z.number().int().min(1).max(5000).default(50),
    })
  ),
  async (c) => {
    const { wallet: walletType, from, to, amount, slippageBps } = c.req.valid("json");
    const adminEmail = (c.get as (key: string) => string | undefined)("adminEmail") || "unknown";

    logger.info("Admin swap requested", { walletType, from, to, amount, slippageBps, adminEmail });

    try {
      const adminWallet = getAdminWallet(walletType);
      if (!adminWallet) {
        return error(c, `Admin wallet '${walletType}' is not configured.`, 503);
      }

      const agentAddress = adminWallet.address;

      // Resolve token symbols to mints
      const fromResolved = await resolveTokenMint(from);
      const toResolved = await resolveTokenMint(to);
      const inputMint = fromResolved.mint;
      const outputMint = toResolved.mint;

      // Get input token decimals
      const inputDecimals = fromResolved.decimals ?? 9;
      const amountLamports = Math.floor(amount * Math.pow(10, inputDecimals));

      const jupiterHeaders = {
        "Content-Type": "application/json",
        "x-api-key": config.JUPITER_API_KEY,
      };

      // Get order from Jupiter Ultra API (full amount, no fee deduction)
      const orderParams = new URLSearchParams({
        inputMint,
        outputMint,
        amount: amountLamports.toString(),
        taker: agentAddress,
      });

      const orderUrl = `${JUPITER_ULTRA_API}/order?${orderParams}`;
      logger.info("Admin Jupiter Ultra order request", { url: orderUrl });

      const orderResponse = await fetch(orderUrl, { headers: jupiterHeaders }).then((r) => r.json());

      if (orderResponse.errorCode || orderResponse.errorMessage) {
        const errorMsg = orderResponse.errorMessage || `Error code: ${orderResponse.errorCode}`;
        return error(c, `Jupiter order error: ${errorMsg}`, 400);
      }

      if (!orderResponse.transaction) {
        return error(
          c,
          `No swap route found for ${fromResolved.symbol} → ${toResolved.symbol}. Insufficient liquidity.`,
          400
        );
      }

      // Deserialize and sign
      const transactionBuf = Buffer.from(orderResponse.transaction, "base64");
      const transaction = VersionedTransaction.deserialize(transactionBuf);
      const signedTransaction = await signTransactionAdmin(transaction, agentAddress);

      // Execute via Jupiter Ultra
      const executeResponse = await fetch(`${JUPITER_ULTRA_API}/execute`, {
        method: "POST",
        headers: jupiterHeaders,
        body: JSON.stringify({
          signedTransaction,
          requestId: orderResponse.requestId,
        }),
      }).then((r) => r.json());

      if (executeResponse.status === "Failed" || executeResponse.error) {
        return error(c, `Swap execution failed: ${executeResponse.error || "Unknown error"}`, 500);
      }

      const signature = executeResponse.signature;
      const outputDecimals = toResolved.decimals ?? 9;
      const outputAmount = (
        parseInt(executeResponse.outputAmountResult || orderResponse.outAmount) / Math.pow(10, outputDecimals)
      ).toFixed(6);

      logger.info("Admin swap completed", {
        signature,
        walletType,
        inputMint,
        outputMint,
        inputAmount: amount,
        outputAmount: parseFloat(outputAmount),
        from: fromResolved.symbol,
        to: toResolved.symbol,
        adminEmail,
        noFee: true,
      });

      // Log admin action to audit log (agentId is null for admin actions)
      await createAuditLog({
        agentId: null,
        action: "admin_swap",
        asset: fromResolved.symbol,
        amount,
        signature,
        status: "confirmed",
        metadata: {
          walletType,
          adminEmail,
          inputMint,
          outputMint,
          inputSymbol: fromResolved.symbol,
          outputSymbol: toResolved.symbol,
          outputAmount: parseFloat(outputAmount),
          noFee: true,
        },
      });

      return success(c, "Admin swap completed.", {
        signature,
        explorerUrl: `https://solscan.io/tx/${signature}`,
        wallet: agentAddress,
        inputMint,
        outputMint,
        inputAmount: `${amount} ${fromResolved.symbol}`,
        outputAmount: `${outputAmount} ${toResolved.symbol}`,
        fee: 0,
        note: "No platform fee (admin swap)",
      });
    } catch (err) {
      logger.error("Admin swap failed", { error: String(err), walletType, from, to, amount });
      return error(c, `Swap failed: ${String(err)}`, 500);
    }
  }
);

// =============================================================================
// Balances
// =============================================================================

// GET /wallet/balances
walletRoutes.get("/balances", async (c) => {
  try {
    const wallets: {
      name: string;
      address: string | null;
      configured: boolean;
      balances?: { sol: number; usdc: number };
    }[] = [];

    // Kalshi admin wallet
    const kalshiWallet = getAdminWallet("kalshi");
    if (kalshiWallet) {
      const pubkey = new PublicKey(kalshiWallet.address);
      const solBalance = (await connection.getBalance(pubkey)) / 1e9;
      let usdcBalance = 0;
      try {
        const usdcAccount = await getAssociatedTokenAddress(USDC_MINT, pubkey, false, TOKEN_PROGRAM_ID);
        const accountInfo = await getAccount(connection, usdcAccount, undefined, TOKEN_PROGRAM_ID);
        usdcBalance = Number(accountInfo.amount) / 1e6;
      } catch {
        // No USDC account
      }
      wallets.push({
        name: "kalshi",
        address: kalshiWallet.address,
        configured: true,
        balances: { sol: solBalance, usdc: usdcBalance },
      });
    } else {
      wallets.push({ name: "kalshi", address: null, configured: false });
    }

    // Meteora admin wallet
    const meteoraWallet = getAdminWallet("meteora");
    if (meteoraWallet) {
      const pubkey = new PublicKey(meteoraWallet.address);
      const solBalance = (await connection.getBalance(pubkey)) / 1e9;
      let usdcBalance = 0;
      try {
        const usdcAccount = await getAssociatedTokenAddress(USDC_MINT, pubkey, false, TOKEN_PROGRAM_ID);
        const accountInfo = await getAccount(connection, usdcAccount, undefined, TOKEN_PROGRAM_ID);
        usdcBalance = Number(accountInfo.amount) / 1e6;
      } catch {
        // No USDC account
      }
      wallets.push({
        name: "meteora",
        address: meteoraWallet.address,
        configured: true,
        balances: { sol: solBalance, usdc: usdcBalance },
      });
    } else {
      wallets.push({ name: "meteora", address: null, configured: false });
    }

    // Fee collection wallet (read-only, no signing)
    if (config.KNOT_FEE_WALLET_ADDRESS) {
      const pubkey = new PublicKey(config.KNOT_FEE_WALLET_ADDRESS);
      const solBalance = (await connection.getBalance(pubkey)) / 1e9;
      let usdcBalance = 0;
      try {
        const usdcAccount = await getAssociatedTokenAddress(USDC_MINT, pubkey, false, TOKEN_PROGRAM_ID);
        const accountInfo = await getAccount(connection, usdcAccount, undefined, TOKEN_PROGRAM_ID);
        usdcBalance = Number(accountInfo.amount) / 1e6;
      } catch {
        // No USDC account
      }
      wallets.push({
        name: "fee_collection",
        address: config.KNOT_FEE_WALLET_ADDRESS,
        configured: true,
        balances: { sol: solBalance, usdc: usdcBalance },
      });
    } else {
      wallets.push({ name: "fee_collection", address: null, configured: false });
    }

    // Kalshi portfolio balance (from Kalshi API, not on-chain)
    let kalshiPortfolio: {
      configured: boolean;
      balanceCents?: number;
      balanceDollars?: number;
      portfolioValueCents?: number;
      portfolioValueDollars?: number;
      error?: string;
    } = { configured: false };

    if (config.KALSHI_API_KEY_ID && config.KALSHI_RSA_PRIVATE_KEY) {
      try {
        const kalshiBalance = await kalshiRequest<BalanceResponse>("GET", "/portfolio/balance");
        kalshiPortfolio = {
          configured: true,
          balanceCents: kalshiBalance.balance,
          balanceDollars: kalshiBalance.balance / 100,
          portfolioValueCents: kalshiBalance.portfolio_value,
          portfolioValueDollars: kalshiBalance.portfolio_value / 100,
        };
      } catch (err) {
        logger.error("Failed to fetch Kalshi portfolio balance", { error: String(err) });
        kalshiPortfolio = {
          configured: true,
          error: String(err),
        };
      }
    }

    return success(c, "Admin wallet balances retrieved.", { wallets, kalshiPortfolio });
  } catch (err) {
    logger.error("Failed to retrieve admin wallet balances", { error: String(err) });
    return error(c, "Failed to retrieve wallet balances.", 500, { error: String(err) });
  }
});

export { walletRoutes };
