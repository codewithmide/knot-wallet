import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDecipheriv } from "crypto";
import { db } from "../db/prisma.js";
import { config } from "../config.js";
import { error, success } from "../utils/response.js";
import { connection, signAndBroadcastAdmin, signTransactionAdmin } from "../turnkey/signer.js";
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
import { ReferralProvider } from "@jup-ag/referral-sdk";
import { startAdminOtpFlow, completeAdminOtpFlow, verifyAdminToken } from "../auth/turnkey-auth.js";
import { logger } from "../utils/logger.js";
import { AppError } from "../utils/errors.js";
import { resolveTokenMint } from "../utils/tokens.js";
import { createAuditLog } from "../utils/audit.js";
import { kalshiRequest, type BalanceResponse } from "../kalshi/client.js";

const admin = new Hono();

// USDC mint address (mainnet)
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

const ADMIN_SCOPE = "admin";
const ADMIN_TOKEN_HEADER = "X-Admin-Token";

interface AdminTokenPayload {
  ts: number;
  scope: string;
}

function decodeAdminSecret(): Buffer {
  // Use the same secret as stats for simplicity, or create a separate ADMIN_API_SECRET
  const key = Buffer.from(config.STATS_API_SECRET, "base64");
  if (key.length !== 32) {
    throw new Error("STATS_API_SECRET must be a 32-byte base64 string");
  }
  return key;
}

function decryptAdminToken(token: string, key: Buffer): AdminTokenPayload {
  const raw = Buffer.from(token, "base64");
  if (raw.length < 12 + 16) {
    throw new Error("Invalid admin token length");
  }

  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ciphertext = raw.subarray(12, raw.length - 16);

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  const payload = JSON.parse(plaintext.toString("utf-8")) as AdminTokenPayload;
  if (typeof payload.ts !== "number" || typeof payload.scope !== "string") {
    throw new Error("Invalid admin token payload");
  }

  return payload;
}

function verifyLegacyAdminAuth(token: string): string | null {
  try {
    const key = decodeAdminSecret();
    const payload = decryptAdminToken(token, key);

    // Accept both "admin" and "stats" scope for admin endpoints
    if (payload.scope !== ADMIN_SCOPE && payload.scope !== "stats") {
      return "Invalid admin token scope";
    }

    const ageMs = Math.abs(Date.now() - payload.ts);
    if (ageMs > config.STATS_TOKEN_TTL_SECONDS * 1000) {
      return "Admin token expired";
    }

    return null;
  } catch {
    return "Invalid legacy admin token";
  }
}

// =============================================================================
// Admin Authentication Routes (no middleware - public)
// =============================================================================

// POST /admin/auth/start
// Admin provides email, server sends OTP (only for whitelisted admin emails)
admin.post(
  "/auth/start",
  zValidator("json", z.object({ email: z.string().email() })),
  async (c) => {
    const { email } = c.req.valid("json");

    logger.info("Admin login start requested", { email });

    try {
      const { otpId } = await startAdminOtpFlow(email);

      return success(c, "OTP sent to your email. Check your inbox.", {
        otpId,
      });
    } catch (err) {
      if (err instanceof AppError) {
        logger.warn("Admin login start failed", { email, error: err.message });
        return error(c, err.message, err.statusCode);
      }

      logger.error("Admin login start failed", { email, error: String(err) });
      return error(c, "Failed to send OTP. Please try again.", 500);
    }
  }
);

// POST /admin/auth/complete
// Admin provides OTP, server verifies and returns admin session token
admin.post(
  "/auth/complete",
  zValidator(
    "json",
    z.object({
      email: z.string().email(),
      otpId: z.string().min(1),
      otpCode: z.string().length(6),
    })
  ),
  async (c) => {
    const { email, otpId, otpCode } = c.req.valid("json");

    logger.info("Admin login complete requested", { email });

    try {
      const result = await completeAdminOtpFlow(email, otpId, otpCode);

      logger.info("Admin authenticated", { email });

      return success(c, "Admin authentication successful.", {
        adminToken: result.adminToken,
        email: result.email,
      });
    } catch (err) {
      logger.error("Admin login complete failed", { email, error: String(err) });

      if (err instanceof AppError) {
        return error(c, err.message, err.statusCode);
      }

      return error(c, "Authentication failed. Please try again.", 500);
    }
  }
);

// =============================================================================
// Admin Auth Middleware (for protected routes below)
// Supports both JWT tokens (from OTP flow) and legacy encrypted tokens
// =============================================================================

admin.use("/predictions/*", verifyAdminMiddleware);
admin.use("/liquidity/*", verifyAdminMiddleware);
admin.use("/agents/*", verifyAdminMiddleware);
admin.use("/transactions/*", verifyAdminMiddleware);
admin.use("/dashboard", verifyAdminMiddleware);
admin.use("/wallet/*", verifyAdminMiddleware);
admin.use("/referral/*", verifyAdminMiddleware);

async function verifyAdminMiddleware(c: any, next: () => Promise<void>) {
  const token = c.req.header(ADMIN_TOKEN_HEADER);

  if (!token) {
    return error(c, "Missing admin token.", 401);
  }

  // Try JWT token first (from email OTP flow)
  try {
    const payload = await verifyAdminToken(token);
    c.set("adminEmail", payload.email);
    return next();
  } catch {
    // JWT verification failed, try legacy encrypted token
  }

  // Try legacy encrypted token
  const legacyError = verifyLegacyAdminAuth(token);
  if (legacyError) {
    return error(c, "Unauthorized admin request.", 401, { reason: legacyError });
  }

  return next();
}

// =============================================================================
// Failed Transfers (Critical - needs manual intervention)
// =============================================================================

// GET /admin/predictions/failed-transfers
// View all failed refunds and withdrawal transfers that need manual intervention
admin.get("/predictions/failed-transfers", async (c) => {
  try {
    const failedAuditLogs = await db.auditLog.findMany({
      where: {
        OR: [
          { action: "prediction_buy_refund_failed" },
          { action: "prediction_sell_withdrawal_failed" },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    const failedTransfers = failedAuditLogs.map((log) => ({
      id: log.id,
      agentId: log.agentId,
      action: log.action,
      amount: log.amount,
      toAddress: log.to,
      status: log.status,
      metadata: log.metadata,
      createdAt: log.createdAt.toISOString(),
    }));

    return success(c, "Failed transfers retrieved.", {
      count: failedTransfers.length,
      transfers: failedTransfers,
    });
  } catch (err) {
    return error(c, "Failed to retrieve failed transfers.", 500, { error: String(err) });
  }
});

// =============================================================================
// Deposits
// =============================================================================

// GET /admin/predictions/deposits
// View all prediction deposits
admin.get("/predictions/deposits", async (c) => {
  try {
    const limit = parseInt(c.req.query("limit") || "100");
    const status = c.req.query("status"); // confirmed, pending, failed

    const deposits = await db.predictionDeposit.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    // Get unique agent IDs and fetch agent info
    const agentIds = [...new Set(deposits.map((d) => d.agentId))];
    const agents = await db.agent.findMany({
      where: { id: { in: agentIds } },
      select: { id: true, email: true, solanaAddress: true },
    });
    const agentMap = new Map(agents.map((a) => [a.id, a]));

    const totalDeposits = await db.predictionDeposit.aggregate({
      _sum: { usdcAmount: true },
      _count: true,
    });

    return success(c, "Deposits retrieved.", {
      count: deposits.length,
      totalCount: totalDeposits._count,
      totalAmountUSDC: totalDeposits._sum.usdcAmount || 0,
      deposits: deposits.map((d) => {
        const agent = agentMap.get(d.agentId);
        return {
          id: d.id,
          agentId: d.agentId,
          agentEmail: agent?.email,
          agentWallet: agent?.solanaAddress,
          usdcAmount: d.usdcAmount,
          usdCents: d.usdCents,
          solanaSignature: d.solanaSignature,
          status: d.status,
          createdAt: d.createdAt.toISOString(),
          confirmedAt: d.confirmedAt?.toISOString(),
        };
      }),
    });
  } catch (err) {
    return error(c, "Failed to retrieve deposits.", 500, { error: String(err) });
  }
});

// =============================================================================
// Withdrawals / Proceeds Transfers
// =============================================================================

// GET /admin/predictions/withdrawals
// View all prediction withdrawals (proceeds transferred to agents)
admin.get("/predictions/withdrawals", async (c) => {
  try {
    const limit = parseInt(c.req.query("limit") || "100");
    const status = c.req.query("status"); // confirmed, pending, failed, processing

    const withdrawals = await db.predictionWithdrawal.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    // Get unique agent IDs and fetch agent info
    const agentIds = [...new Set(withdrawals.map((w) => w.agentId))];
    const agents = await db.agent.findMany({
      where: { id: { in: agentIds } },
      select: { id: true, email: true, solanaAddress: true },
    });
    const agentMap = new Map(agents.map((a) => [a.id, a]));

    const totalWithdrawals = await db.predictionWithdrawal.aggregate({
      _sum: { usdcAmount: true },
      _count: true,
    });

    return success(c, "Withdrawals retrieved.", {
      count: withdrawals.length,
      totalCount: totalWithdrawals._count,
      totalAmountUSDC: totalWithdrawals._sum.usdcAmount || 0,
      withdrawals: withdrawals.map((w) => {
        const agent = agentMap.get(w.agentId);
        return {
          id: w.id,
          agentId: w.agentId,
          agentEmail: agent?.email,
          agentWallet: agent?.solanaAddress,
          usdcAmount: w.usdcAmount,
          usdCents: w.usdCents,
          solanaSignature: w.solanaSignature,
          status: w.status,
          createdAt: w.createdAt.toISOString(),
          processedAt: w.processedAt?.toISOString(),
        };
      }),
    });
  } catch (err) {
    return error(c, "Failed to retrieve withdrawals.", 500, { error: String(err) });
  }
});

// =============================================================================
// Orders
// =============================================================================

// GET /admin/predictions/orders
// View all prediction orders across all agents
admin.get("/predictions/orders", async (c) => {
  try {
    const limit = parseInt(c.req.query("limit") || "100");
    const action = c.req.query("action"); // buy, sell
    const status = c.req.query("status"); // filled, cancelled, etc.

    const orders = await db.predictionOrder.findMany({
      where: {
        ...(action ? { action } : {}),
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    // Get unique agent IDs and fetch agent info
    const agentIds = [...new Set(orders.map((o) => o.agentId))];
    const agents = await db.agent.findMany({
      where: { id: { in: agentIds } },
      select: { id: true, email: true, solanaAddress: true },
    });
    const agentMap = new Map(agents.map((a) => [a.id, a]));

    const summary = await db.predictionOrder.aggregate({
      _sum: { totalCost: true, feeCents: true },
      _count: true,
    });

    return success(c, "Orders retrieved.", {
      count: orders.length,
      totalCount: summary._count,
      totalVolumeCents: Math.abs(summary._sum.totalCost || 0),
      totalFeesCents: summary._sum.feeCents || 0,
      orders: orders.map((o) => {
        const agent = agentMap.get(o.agentId);
        return {
          id: o.id,
          agentId: o.agentId,
          agentEmail: agent?.email,
          ticker: o.ticker,
          eventTicker: o.eventTicker,
          side: o.side,
          action: o.action,
          count: o.count,
          pricePerContract: o.pricePerContract,
          totalCost: o.totalCost,
          feeCents: o.feeCents,
          kalshiOrderId: o.kalshiOrderId,
          status: o.status,
          createdAt: o.createdAt.toISOString(),
          filledAt: o.filledAt?.toISOString(),
        };
      }),
    });
  } catch (err) {
    return error(c, "Failed to retrieve orders.", 500, { error: String(err) });
  }
});

// =============================================================================
// Positions
// =============================================================================

// GET /admin/predictions/positions
// View all positions across all agents
admin.get("/predictions/positions", async (c) => {
  try {
    const limit = parseInt(c.req.query("limit") || "100");
    const settled = c.req.query("settled");

    const positions = await db.predictionPosition.findMany({
      where: settled !== undefined ? { settled: settled === "true" } : undefined,
      orderBy: { updatedAt: "desc" },
      take: limit,
    });

    // Get unique agent IDs and fetch agent info
    const agentIds = [...new Set(positions.map((p) => p.agentId))];
    const agents = await db.agent.findMany({
      where: { id: { in: agentIds } },
      select: { id: true, email: true, solanaAddress: true },
    });
    const agentMap = new Map(agents.map((a) => [a.id, a]));

    const summary = await db.predictionPosition.aggregate({
      _sum: { quantity: true, totalCost: true },
      _count: true,
    });

    return success(c, "Positions retrieved.", {
      count: positions.length,
      totalCount: summary._count,
      totalContracts: summary._sum.quantity || 0,
      totalCostCents: summary._sum.totalCost || 0,
      positions: positions.map((p) => {
        const agent = agentMap.get(p.agentId);
        return {
          id: p.id,
          agentId: p.agentId,
          agentEmail: agent?.email,
          ticker: p.ticker,
          eventTicker: p.eventTicker,
          side: p.side,
          quantity: p.quantity,
          averageCost: p.averageCost,
          totalCost: p.totalCost,
          settled: p.settled,
          settlementResult: p.settlementResult,
          settlementPayout: p.settlementPayout,
          settledAt: p.settledAt?.toISOString(),
          createdAt: p.createdAt.toISOString(),
          updatedAt: p.updatedAt.toISOString(),
        };
      }),
    });
  } catch (err) {
    return error(c, "Failed to retrieve positions.", 500, { error: String(err) });
  }
});

// =============================================================================
// Admin Wallet Status
// =============================================================================

// GET /admin/predictions/wallet
// View admin wallet balance and status (for monitoring)
admin.get("/predictions/wallet", async (c) => {
  try {
    if (!config.KNOT_KALSHI_ADMIN_WALLET_ADDRESS) {
      return error(c, "Admin wallet not configured", 503);
    }

    const adminPubkey = new PublicKey(config.KNOT_KALSHI_ADMIN_WALLET_ADDRESS);

    // Get SOL balance
    const solBalance = await connection.getBalance(adminPubkey);
    const solBalanceLamports = solBalance;
    const solBalanceSOL = solBalance / 1e9;

    // Get USDC balance
    let usdcBalance = 0;
    let usdcBalanceRaw = BigInt(0);
    try {
      const usdcTokenAccount = await getAssociatedTokenAddress(
        USDC_MINT,
        adminPubkey,
        false,
        TOKEN_PROGRAM_ID
      );
      const accountInfo = await getAccount(connection, usdcTokenAccount, undefined, TOKEN_PROGRAM_ID);
      usdcBalanceRaw = accountInfo.amount;
      usdcBalance = Number(usdcBalanceRaw) / 1e6; // USDC has 6 decimals
    } catch {
      // Token account doesn't exist, balance is 0
    }

    // Get total deposits and withdrawals for reconciliation
    const [totalDeposits, totalWithdrawals] = await Promise.all([
      db.predictionDeposit.aggregate({
        where: { status: "confirmed" },
        _sum: { usdcAmount: true },
      }),
      db.predictionWithdrawal.aggregate({
        where: { status: "confirmed" },
        _sum: { usdcAmount: true },
      }),
    ]);

    const expectedBalance =
      (totalDeposits._sum.usdcAmount || 0) - (totalWithdrawals._sum.usdcAmount || 0);

    return success(c, "Admin wallet status retrieved.", {
      wallet: {
        address: config.KNOT_KALSHI_ADMIN_WALLET_ADDRESS,
        solBalance: {
          lamports: solBalanceLamports,
          sol: solBalanceSOL,
        },
        usdcBalance: {
          raw: usdcBalanceRaw.toString(),
          usdc: usdcBalance,
        },
      },
      reconciliation: {
        totalDepositsUSDC: totalDeposits._sum.usdcAmount || 0,
        totalWithdrawalsUSDC: totalWithdrawals._sum.usdcAmount || 0,
        expectedBalanceUSDC: expectedBalance,
        actualBalanceUSDC: usdcBalance,
        discrepancyUSDC: usdcBalance - expectedBalance,
      },
    });
  } catch (err) {
    return error(c, "Failed to retrieve wallet status.", 500, { error: String(err) });
  }
});

// =============================================================================
// Agent Balances Overview
// =============================================================================

// GET /admin/predictions/balances
// View all agents with prediction activity (deposits, orders, positions)
// Note: The "balance" field may be 0 for agents using direct buy/sell flow
admin.get("/predictions/balances", async (c) => {
  try {
    logger.info("Fetching prediction activity by agent");

    // Get all agents who have any prediction activity
    // 1. Agents with prediction balance records
    // 2. Agents with deposits
    // 3. Agents with orders
    // 4. Agents with positions
    const [balanceRecords, depositsByAgent, ordersByAgent, positionsByAgent] = await Promise.all([
      db.predictionBalance.findMany({
        orderBy: { updatedAt: "desc" },
      }),
      db.predictionDeposit.groupBy({
        by: ["agentId"],
        _sum: { usdcAmount: true },
        _count: true,
      }),
      db.predictionOrder.groupBy({
        by: ["agentId"],
        _sum: { totalCost: true, feeCents: true },
        _count: true,
      }),
      db.predictionPosition.groupBy({
        by: ["agentId"],
        where: { settled: false },
        _sum: { totalCost: true, quantity: true },
        _count: true,
      }),
    ]);

    // Create maps for quick lookup
    const balanceMap = new Map(balanceRecords.map(b => [b.agentId, b]));
    const depositsMap = new Map(depositsByAgent.map(d => [d.agentId, d]));
    const ordersMap = new Map(ordersByAgent.map(o => [o.agentId, o]));
    const positionsMap = new Map(positionsByAgent.map(p => [p.agentId, p]));

    // Get all unique agent IDs with any activity
    const allAgentIds = new Set([
      ...balanceRecords.map(b => b.agentId),
      ...depositsByAgent.map(d => d.agentId),
      ...ordersByAgent.map(o => o.agentId),
      ...positionsByAgent.map(p => p.agentId),
    ]);

    logger.info("Found agents with prediction activity", {
      uniqueAgents: allAgentIds.size,
      balanceRecords: balanceRecords.length,
      agentsWithDeposits: depositsByAgent.length,
      agentsWithOrders: ordersByAgent.length,
      agentsWithPositions: positionsByAgent.length,
    });

    // Fetch agent info
    const agents = await db.agent.findMany({
      where: { id: { in: Array.from(allAgentIds) } },
      select: { id: true, email: true, solanaAddress: true },
    });
    const agentMap = new Map(agents.map(a => [a.id, a]));

    // Build combined activity data
    const agentActivities = Array.from(allAgentIds).map(agentId => {
      const agent = agentMap.get(agentId);
      const balance = balanceMap.get(agentId);
      const deposits = depositsMap.get(agentId);
      const orders = ordersMap.get(agentId);
      const positions = positionsMap.get(agentId);

      return {
        agentId,
        agentEmail: agent?.email,
        agentWallet: agent?.solanaAddress,
        // Internal balance (may be 0 for direct buy/sell flow)
        internalBalanceCents: balance?.balance || 0,
        internalBalanceDollars: (balance?.balance || 0) / 100,
        // Deposit activity
        totalDepositsUSDC: deposits?._sum.usdcAmount || 0,
        depositCount: deposits?._count || 0,
        // Order activity
        totalOrderVolumeCents: Math.abs(orders?._sum.totalCost || 0),
        totalFeesPaidCents: orders?._sum.feeCents || 0,
        orderCount: orders?._count || 0,
        // Open positions
        openPositionCount: positions?._count || 0,
        openPositionCostCents: positions?._sum.totalCost || 0,
        openContractsCount: positions?._sum.quantity || 0,
        // Last activity
        lastActivity: balance?.updatedAt?.toISOString(),
      };
    });

    // Sort by total activity (orders + deposits)
    agentActivities.sort((a, b) => {
      const aActivity = a.orderCount + a.depositCount;
      const bActivity = b.orderCount + b.depositCount;
      return bActivity - aActivity;
    });

    // Calculate totals
    const totalInternalBalance = balanceRecords.reduce((sum, b) => sum + b.balance, 0);

    return success(c, "Agent prediction activity retrieved.", {
      count: agentActivities.length,
      totalInternalBalanceCents: totalInternalBalance,
      totalInternalBalanceDollars: totalInternalBalance / 100,
      agents: agentActivities,
    });
  } catch (err) {
    logger.error("Failed to retrieve prediction balances", { error: String(err) });
    return error(c, "Failed to retrieve balances.", 500, { error: String(err) });
  }
});

// =============================================================================
// Summary Dashboard
// =============================================================================

// GET /admin/predictions/summary
// Get a summary of all prediction activity
admin.get("/predictions/summary", async (c) => {
  try {
    const [
      totalDeposits,
      totalWithdrawals,
      totalOrders,
      totalPositions,
      failedTransfers,
      pendingWithdrawals,
    ] = await Promise.all([
      db.predictionDeposit.aggregate({
        where: { status: "confirmed" },
        _sum: { usdcAmount: true },
        _count: true,
      }),
      db.predictionWithdrawal.aggregate({
        where: { status: "confirmed" },
        _sum: { usdcAmount: true },
        _count: true,
      }),
      db.predictionOrder.aggregate({
        _sum: { feeCents: true },
        _count: true,
      }),
      db.predictionPosition.count({
        where: { settled: false },
      }),
      db.auditLog.count({
        where: {
          OR: [
            { action: "prediction_buy_refund_failed" },
            { action: "prediction_sell_withdrawal_failed" },
          ],
        },
      }),
      db.predictionWithdrawal.count({
        where: { status: { in: ["pending", "processing"] } },
      }),
    ]);

    return success(c, "Prediction summary retrieved.", {
      deposits: {
        count: totalDeposits._count,
        totalUSDC: totalDeposits._sum.usdcAmount || 0,
      },
      withdrawals: {
        count: totalWithdrawals._count,
        totalUSDC: totalWithdrawals._sum.usdcAmount || 0,
      },
      orders: {
        count: totalOrders._count,
        totalFeesCents: totalOrders._sum.feeCents || 0,
        totalFeesDollars: (totalOrders._sum.feeCents || 0) / 100,
      },
      positions: {
        openCount: totalPositions,
      },
      alerts: {
        failedTransfers,
        pendingWithdrawals,
      },
    });
  } catch (err) {
    return error(c, "Failed to retrieve summary.", 500, { error: String(err) });
  }
});

// =============================================================================
// LIQUIDITY PROVISION (Meteora DLMM) ADMIN ENDPOINTS
// =============================================================================

// GET /admin/liquidity/summary
// Get a summary of all liquidity activity
admin.get("/liquidity/summary", async (c) => {
  try {
    const [
      totalDeposits,
      totalWithdrawals,
      totalPositions,
      activePositions,
      totalRewardClaims,
      failedTransfers,
    ] = await Promise.all([
      db.liquidityDeposit.aggregate({
        where: { status: "confirmed" },
        _sum: { amount: true },
        _count: true,
      }),
      db.liquidityWithdrawal.aggregate({
        where: { status: "confirmed" },
        _sum: { amount: true, feeAmount: true },
        _count: true,
      }),
      db.liquidityPosition.count(),
      db.liquidityPosition.count({
        where: { status: "active" },
      }),
      db.liquidityRewardClaim.aggregate({
        where: { status: "confirmed" },
        _sum: { feeX: true, feeY: true, platformFeeX: true, platformFeeY: true },
        _count: true,
      }),
      db.auditLog.count({
        where: {
          OR: [
            { action: "liquidity_add_refund_failed" },
            { action: "liquidity_remove_withdrawal_failed" },
            { action: "liquidity_claim_withdrawal_failed" },
          ],
        },
      }),
    ]);

    return success(c, "Liquidity summary retrieved.", {
      deposits: {
        count: totalDeposits._count,
        totalAmount: totalDeposits._sum.amount || 0,
      },
      withdrawals: {
        count: totalWithdrawals._count,
        totalAmount: totalWithdrawals._sum.amount || 0,
        totalFeesCollected: totalWithdrawals._sum.feeAmount || 0,
      },
      positions: {
        total: totalPositions,
        active: activePositions,
        closed: totalPositions - activePositions,
      },
      rewards: {
        claimsCount: totalRewardClaims._count,
        totalFeeXClaimed: totalRewardClaims._sum.feeX || 0,
        totalFeeYClaimed: totalRewardClaims._sum.feeY || 0,
        platformFeesXCollected: totalRewardClaims._sum.platformFeeX || 0,
        platformFeesYCollected: totalRewardClaims._sum.platformFeeY || 0,
      },
      alerts: {
        failedTransfers,
      },
    });
  } catch (err) {
    return error(c, "Failed to retrieve liquidity summary.", 500, { error: String(err) });
  }
});

// GET /admin/liquidity/failed-transfers
// View all failed transfers that need manual intervention
admin.get("/liquidity/failed-transfers", async (c) => {
  try {
    const failedAuditLogs = await db.auditLog.findMany({
      where: {
        OR: [
          { action: "liquidity_add_refund_failed" },
          { action: "liquidity_remove_withdrawal_failed" },
          { action: "liquidity_claim_withdrawal_failed" },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    const failedTransfers = failedAuditLogs.map((log) => ({
      id: log.id,
      agentId: log.agentId,
      action: log.action,
      asset: log.asset,
      amount: log.amount,
      toAddress: log.to,
      status: log.status,
      metadata: log.metadata,
      createdAt: log.createdAt.toISOString(),
    }));

    return success(c, "Failed liquidity transfers retrieved.", {
      count: failedTransfers.length,
      transfers: failedTransfers,
    });
  } catch (err) {
    return error(c, "Failed to retrieve failed transfers.", 500, { error: String(err) });
  }
});

// GET /admin/liquidity/deposits
// View all liquidity deposits (tokens sent by agents to admin)
admin.get("/liquidity/deposits", async (c) => {
  try {
    const limit = parseInt(c.req.query("limit") || "100");
    const status = c.req.query("status");
    const poolAddress = c.req.query("pool");

    const deposits = await db.liquidityDeposit.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(poolAddress ? { poolAddress } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    const agentIds = [...new Set(deposits.map((d) => d.agentId))];
    const agents = await db.agent.findMany({
      where: { id: { in: agentIds } },
      select: { id: true, email: true, solanaAddress: true },
    });
    const agentMap = new Map(agents.map((a) => [a.id, a]));

    const totalDeposits = await db.liquidityDeposit.aggregate({
      where: { status: "confirmed" },
      _sum: { amount: true },
      _count: true,
    });

    return success(c, "Liquidity deposits retrieved.", {
      count: deposits.length,
      totalCount: totalDeposits._count,
      deposits: deposits.map((d) => {
        const agent = agentMap.get(d.agentId);
        return {
          id: d.id,
          agentId: d.agentId,
          agentEmail: agent?.email,
          agentWallet: agent?.solanaAddress,
          poolAddress: d.poolAddress,
          tokenMint: d.tokenMint,
          tokenSymbol: d.tokenSymbol,
          amount: d.amount,
          amountRaw: d.amountRaw,
          solanaSignature: d.solanaSignature,
          status: d.status,
          createdAt: d.createdAt.toISOString(),
          confirmedAt: d.confirmedAt?.toISOString(),
        };
      }),
    });
  } catch (err) {
    return error(c, "Failed to retrieve deposits.", 500, { error: String(err) });
  }
});

// GET /admin/liquidity/withdrawals
// View all liquidity withdrawals (proceeds sent to agents)
admin.get("/liquidity/withdrawals", async (c) => {
  try {
    const limit = parseInt(c.req.query("limit") || "100");
    const status = c.req.query("status");
    const poolAddress = c.req.query("pool");

    const withdrawals = await db.liquidityWithdrawal.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(poolAddress ? { poolAddress } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    const agentIds = [...new Set(withdrawals.map((w) => w.agentId))];
    const agents = await db.agent.findMany({
      where: { id: { in: agentIds } },
      select: { id: true, email: true, solanaAddress: true },
    });
    const agentMap = new Map(agents.map((a) => [a.id, a]));

    const totalWithdrawals = await db.liquidityWithdrawal.aggregate({
      where: { status: "confirmed" },
      _sum: { amount: true, feeAmount: true },
      _count: true,
    });

    return success(c, "Liquidity withdrawals retrieved.", {
      count: withdrawals.length,
      totalCount: totalWithdrawals._count,
      totalAmount: totalWithdrawals._sum.amount || 0,
      totalFeesCollected: totalWithdrawals._sum.feeAmount || 0,
      withdrawals: withdrawals.map((w) => {
        const agent = agentMap.get(w.agentId);
        return {
          id: w.id,
          agentId: w.agentId,
          agentEmail: agent?.email,
          agentWallet: agent?.solanaAddress,
          poolAddress: w.poolAddress,
          positionId: w.positionId,
          tokenMint: w.tokenMint,
          tokenSymbol: w.tokenSymbol,
          amount: w.amount,
          amountRaw: w.amountRaw,
          feeBps: w.feeBps,
          feeAmount: w.feeAmount,
          solanaSignature: w.solanaSignature,
          status: w.status,
          createdAt: w.createdAt.toISOString(),
          processedAt: w.processedAt?.toISOString(),
        };
      }),
    });
  } catch (err) {
    return error(c, "Failed to retrieve withdrawals.", 500, { error: String(err) });
  }
});

// GET /admin/liquidity/positions
// View all LP positions across all agents
admin.get("/liquidity/positions", async (c) => {
  try {
    const limit = parseInt(c.req.query("limit") || "100");
    const status = c.req.query("status"); // active, closed
    const poolAddress = c.req.query("pool");

    const positions = await db.liquidityPosition.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(poolAddress ? { poolAddress } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    const agentIds = [...new Set(positions.map((p) => p.agentId))];
    const agents = await db.agent.findMany({
      where: { id: { in: agentIds } },
      select: { id: true, email: true, solanaAddress: true },
    });
    const agentMap = new Map(agents.map((a) => [a.id, a]));

    const summary = await db.liquidityPosition.aggregate({
      _count: true,
    });

    return success(c, "Liquidity positions retrieved.", {
      count: positions.length,
      totalCount: summary._count,
      positions: positions.map((p) => {
        const agent = agentMap.get(p.agentId);
        return {
          id: p.id,
          agentId: p.agentId,
          agentEmail: agent?.email,
          poolAddress: p.poolAddress,
          poolName: p.poolName,
          positionPubkey: p.positionPubkey,
          strategy: p.strategy,
          minBinId: p.minBinId,
          maxBinId: p.maxBinId,
          amountX: p.amountX,
          amountY: p.amountY,
          mintX: p.mintX,
          mintY: p.mintY,
          symbolX: p.symbolX,
          symbolY: p.symbolY,
          entryFeeBps: p.entryFeeBps,
          exitFeeBps: p.exitFeeBps,
          status: p.status,
          createdAt: p.createdAt.toISOString(),
          closedAt: p.closedAt?.toISOString(),
        };
      }),
    });
  } catch (err) {
    return error(c, "Failed to retrieve positions.", 500, { error: String(err) });
  }
});

// GET /admin/liquidity/rewards
// View all reward claims
admin.get("/liquidity/rewards", async (c) => {
  try {
    const limit = parseInt(c.req.query("limit") || "100");
    const status = c.req.query("status");

    const claims = await db.liquidityRewardClaim.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    const agentIds = [...new Set(claims.map((c) => c.agentId))];
    const agents = await db.agent.findMany({
      where: { id: { in: agentIds } },
      select: { id: true, email: true, solanaAddress: true },
    });
    const agentMap = new Map(agents.map((a) => [a.id, a]));

    const summary = await db.liquidityRewardClaim.aggregate({
      where: { status: "confirmed" },
      _sum: { feeX: true, feeY: true, platformFeeX: true, platformFeeY: true },
      _count: true,
    });

    return success(c, "Reward claims retrieved.", {
      count: claims.length,
      totalCount: summary._count,
      totals: {
        feeX: summary._sum.feeX || 0,
        feeY: summary._sum.feeY || 0,
        platformFeeX: summary._sum.platformFeeX || 0,
        platformFeeY: summary._sum.platformFeeY || 0,
      },
      claims: claims.map((cl) => {
        const agent = agentMap.get(cl.agentId);
        return {
          id: cl.id,
          agentId: cl.agentId,
          agentEmail: agent?.email,
          positionId: cl.positionId,
          poolAddress: cl.poolAddress,
          feeX: cl.feeX,
          feeY: cl.feeY,
          platformFeeBps: cl.platformFeeBps,
          platformFeeX: cl.platformFeeX,
          platformFeeY: cl.platformFeeY,
          solanaSignatureX: cl.solanaSignatureX,
          solanaSignatureY: cl.solanaSignatureY,
          status: cl.status,
          createdAt: cl.createdAt.toISOString(),
          processedAt: cl.processedAt?.toISOString(),
        };
      }),
    });
  } catch (err) {
    return error(c, "Failed to retrieve reward claims.", 500, { error: String(err) });
  }
});

// GET /admin/liquidity/wallet
// View admin wallet balance and status for Meteora
admin.get("/liquidity/wallet", async (c) => {
  try {
    if (!config.KNOT_METEORA_ADMIN_WALLET_ADDRESS) {
      return error(c, "Meteora admin wallet not configured", 503);
    }

    const adminPubkey = new PublicKey(config.KNOT_METEORA_ADMIN_WALLET_ADDRESS);

    // Get SOL balance
    const solBalance = await connection.getBalance(adminPubkey);
    const solBalanceSOL = solBalance / 1e9;

    // Get common token balances
    const tokenBalances: { mint: string; symbol: string; balance: number }[] = [];

    // Common tokens to check (USDC, USDT, SOL wrapped)
    const tokensToCheck = [
      { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", decimals: 6 },
      { mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", symbol: "USDT", decimals: 6 },
    ];

    for (const token of tokensToCheck) {
      try {
        const tokenAccount = await getAssociatedTokenAddress(
          new PublicKey(token.mint),
          adminPubkey,
          false,
          TOKEN_PROGRAM_ID
        );
        const accountInfo = await getAccount(connection, tokenAccount, undefined, TOKEN_PROGRAM_ID);
        tokenBalances.push({
          mint: token.mint,
          symbol: token.symbol,
          balance: Number(accountInfo.amount) / Math.pow(10, token.decimals),
        });
      } catch {
        // Token account doesn't exist
        tokenBalances.push({
          mint: token.mint,
          symbol: token.symbol,
          balance: 0,
        });
      }
    }

    // Get position summary
    const [activePositions, totalDeposits, totalWithdrawals] = await Promise.all([
      db.liquidityPosition.count({ where: { status: "active" } }),
      db.liquidityDeposit.aggregate({
        where: { status: "confirmed" },
        _count: true,
      }),
      db.liquidityWithdrawal.aggregate({
        where: { status: "confirmed" },
        _sum: { feeAmount: true },
        _count: true,
      }),
    ]);

    return success(c, "Meteora admin wallet status retrieved.", {
      wallet: {
        address: config.KNOT_METEORA_ADMIN_WALLET_ADDRESS,
        solBalance: solBalanceSOL,
        tokenBalances,
      },
      activity: {
        activePositions,
        totalDeposits: totalDeposits._count,
        totalWithdrawals: totalWithdrawals._count,
        totalFeesCollected: totalWithdrawals._sum.feeAmount || 0,
      },
    });
  } catch (err) {
    return error(c, "Failed to retrieve wallet status.", 500, { error: String(err) });
  }
});

// =============================================================================
// AGENTS MANAGEMENT
// =============================================================================

// GET /admin/agents
// List all agents with pagination and filtering
admin.get("/agents", async (c) => {
  try {
    const limit = parseInt(c.req.query("limit") || "100");
    const offset = parseInt(c.req.query("offset") || "0");
    const search = c.req.query("search"); // Search by email or wallet address
    const sortBy = c.req.query("sortBy") || "createdAt"; // createdAt, lastActiveAt, email
    const sortOrder = c.req.query("sortOrder") || "desc"; // asc, desc

    // Build where clause for search
    const whereClause = search
      ? {
          OR: [
            { email: { contains: search, mode: "insensitive" as const } },
            { solanaAddress: { contains: search, mode: "insensitive" as const } },
            { username: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {};

    // Build orderBy
    const orderBy: Record<string, "asc" | "desc"> = {};
    if (["createdAt", "lastActiveAt", "email", "username"].includes(sortBy)) {
      orderBy[sortBy] = sortOrder === "asc" ? "asc" : "desc";
    } else {
      orderBy.createdAt = "desc";
    }

    const [agents, totalCount] = await Promise.all([
      db.agent.findMany({
        where: whereClause,
        orderBy,
        take: limit,
        skip: offset,
        include: {
          policy: true,
          _count: {
            select: {
              auditLogs: true,
            },
          },
        },
      }),
      db.agent.count({ where: whereClause }),
    ]);

    // Get activity stats for each agent
    const agentIds = agents.map((a) => a.id);
    const [transferStats, tradeStats] = await Promise.all([
      db.auditLog.groupBy({
        by: ["agentId"],
        where: {
          agentId: { in: agentIds },
          action: "transfer",
          status: "confirmed",
        },
        _count: true,
        _sum: { amount: true },
      }),
      db.auditLog.groupBy({
        by: ["agentId"],
        where: {
          agentId: { in: agentIds },
          action: "trade",
          status: "confirmed",
        },
        _count: true,
      }),
    ]);

    const transferMap = new Map(transferStats.map((t) => [t.agentId, t]));
    const tradeMap = new Map(tradeStats.map((t) => [t.agentId, t]));

    return success(c, "Agents retrieved.", {
      count: agents.length,
      totalCount,
      limit,
      offset,
      agents: agents.map((agent) => {
        const transfers = transferMap.get(agent.id);
        const trades = tradeMap.get(agent.id);
        return {
          id: agent.id,
          email: agent.email,
          username: agent.username,
          solanaAddress: agent.solanaAddress,
          turnkeyWalletId: agent.turnkeyWalletId,
          turnkeySubOrgId: agent.turnkeySubOrgId,
          createdAt: agent.createdAt.toISOString(),
          updatedAt: agent.updatedAt.toISOString(),
          lastActiveAt: agent.lastActiveAt.toISOString(),
          hasPolicy: !!agent.policy,
          totalTransactions: agent._count.auditLogs,
          stats: {
            transfers: {
              count: transfers?._count || 0,
              totalAmount: transfers?._sum.amount || 0,
            },
            trades: {
              count: trades?._count || 0,
            },
          },
        };
      }),
    });
  } catch (err) {
    logger.error("Failed to retrieve agents", { error: String(err) });
    return error(c, "Failed to retrieve agents.", 500, { error: String(err) });
  }
});

// GET /admin/agents/:id
// Get detailed info for a specific agent
admin.get("/agents/:id", async (c) => {
  try {
    const agentId = c.req.param("id");

    const agent = await db.agent.findUnique({
      where: { id: agentId },
      include: {
        policy: true,
        auditLogs: {
          orderBy: { createdAt: "desc" },
          take: 50,
        },
      },
    });

    if (!agent) {
      return error(c, "Agent not found.", 404);
    }

    // Get activity summary
    const [
      totalTransfers,
      totalTrades,
      recentActivity,
      predictionOrders,
      liquidityPositions,
    ] = await Promise.all([
      db.auditLog.aggregate({
        where: { agentId, action: "transfer", status: "confirmed" },
        _count: true,
        _sum: { amount: true },
      }),
      db.auditLog.aggregate({
        where: { agentId, action: "trade", status: "confirmed" },
        _count: true,
      }),
      db.auditLog.findMany({
        where: { agentId },
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
      db.predictionOrder.count({ where: { agentId } }),
      db.liquidityPosition.count({ where: { agentId } }),
    ]);

    // Get on-chain balance
    let solBalance = 0;
    let usdcBalance = 0;
    try {
      const pubkey = new PublicKey(agent.solanaAddress);
      solBalance = (await connection.getBalance(pubkey)) / 1e9;

      try {
        const usdcTokenAccount = await getAssociatedTokenAddress(
          USDC_MINT,
          pubkey,
          false,
          TOKEN_PROGRAM_ID
        );
        const accountInfo = await getAccount(connection, usdcTokenAccount, undefined, TOKEN_PROGRAM_ID);
        usdcBalance = Number(accountInfo.amount) / 1e6;
      } catch {
        // No USDC account
      }
    } catch {
      // Balance fetch failed
    }

    return success(c, "Agent details retrieved.", {
      agent: {
        id: agent.id,
        email: agent.email,
        username: agent.username,
        solanaAddress: agent.solanaAddress,
        turnkeyWalletId: agent.turnkeyWalletId,
        turnkeySubOrgId: agent.turnkeySubOrgId,
        createdAt: agent.createdAt.toISOString(),
        updatedAt: agent.updatedAt.toISOString(),
        lastActiveAt: agent.lastActiveAt.toISOString(),
      },
      balances: {
        sol: solBalance,
        usdc: usdcBalance,
      },
      policy: agent.policy?.rules || null,
      stats: {
        transfers: {
          count: totalTransfers._count,
          totalAmount: totalTransfers._sum.amount || 0,
        },
        trades: {
          count: totalTrades._count,
        },
        predictions: {
          orderCount: predictionOrders,
        },
        liquidity: {
          positionCount: liquidityPositions,
        },
      },
      recentActivity: recentActivity.map((log) => ({
        id: log.id,
        action: log.action,
        asset: log.asset,
        amount: log.amount,
        to: log.to,
        signature: log.signature,
        status: log.status,
        createdAt: log.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    logger.error("Failed to retrieve agent details", { error: String(err) });
    return error(c, "Failed to retrieve agent details.", 500, { error: String(err) });
  }
});

// =============================================================================
// TRANSACTIONS / AUDIT LOGS
// =============================================================================

// GET /admin/transactions
// List all transactions (audit logs) across all agents
admin.get("/transactions", async (c) => {
  try {
    const limit = parseInt(c.req.query("limit") || "100");
    const offset = parseInt(c.req.query("offset") || "0");
    const action = c.req.query("action"); // transfer, trade, sign_message, deposit, etc.
    const status = c.req.query("status"); // confirmed, failed, rejected_by_policy
    const asset = c.req.query("asset"); // sol, usdc, etc.
    const agentId = c.req.query("agentId");

    const whereClause: Record<string, unknown> = {};
    if (action) whereClause.action = action;
    if (status) whereClause.status = status;
    if (asset) whereClause.asset = asset;
    if (agentId) whereClause.agentId = agentId;

    const [transactions, totalCount, actionStats] = await Promise.all([
      db.auditLog.findMany({
        where: whereClause,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      db.auditLog.count({ where: whereClause }),
      db.auditLog.groupBy({
        by: ["action", "status"],
        _count: true,
      }),
    ]);

    // Get agent info for the transactions
    const agentIds = [...new Set(transactions.map((t) => t.agentId))];
    const agents = await db.agent.findMany({
      where: { id: { in: agentIds } },
      select: { id: true, email: true, solanaAddress: true },
    });
    const agentMap = new Map(agents.map((a) => [a.id, a]));

    // Organize action stats
    const statsSummary: Record<string, { total: number; confirmed: number; failed: number }> = {};
    for (const stat of actionStats) {
      if (!statsSummary[stat.action]) {
        statsSummary[stat.action] = { total: 0, confirmed: 0, failed: 0 };
      }
      statsSummary[stat.action].total += stat._count;
      if (stat.status === "confirmed") {
        statsSummary[stat.action].confirmed += stat._count;
      } else if (stat.status === "failed") {
        statsSummary[stat.action].failed += stat._count;
      }
    }

    return success(c, "Transactions retrieved.", {
      count: transactions.length,
      totalCount,
      limit,
      offset,
      stats: statsSummary,
      transactions: transactions.map((tx) => {
        const agent = agentMap.get(tx.agentId);
        return {
          id: tx.id,
          agentId: tx.agentId,
          agentEmail: agent?.email,
          agentWallet: agent?.solanaAddress,
          action: tx.action,
          asset: tx.asset,
          amount: tx.amount,
          from: tx.from,
          to: tx.to,
          signature: tx.signature,
          status: tx.status,
          metadata: tx.metadata,
          createdAt: tx.createdAt.toISOString(),
        };
      }),
    });
  } catch (err) {
    logger.error("Failed to retrieve transactions", { error: String(err) });
    return error(c, "Failed to retrieve transactions.", 500, { error: String(err) });
  }
});

// GET /admin/transactions/agent/:agentId
// Get all transactions for a specific agent
admin.get("/transactions/agent/:agentId", async (c) => {
  try {
    const agentId = c.req.param("agentId");
    const limit = parseInt(c.req.query("limit") || "100");
    const offset = parseInt(c.req.query("offset") || "0");
    const action = c.req.query("action");
    const status = c.req.query("status");

    // Verify agent exists
    const agent = await db.agent.findUnique({
      where: { id: agentId },
      select: { id: true, email: true, solanaAddress: true },
    });

    if (!agent) {
      return error(c, "Agent not found.", 404);
    }

    const whereClause: Record<string, unknown> = { agentId };
    if (action) whereClause.action = action;
    if (status) whereClause.status = status;

    const [transactions, totalCount, stats] = await Promise.all([
      db.auditLog.findMany({
        where: whereClause,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      db.auditLog.count({ where: whereClause }),
      db.auditLog.groupBy({
        by: ["action"],
        where: { agentId },
        _count: true,
        _sum: { amount: true },
      }),
    ]);

    return success(c, "Agent transactions retrieved.", {
      agent: {
        id: agent.id,
        email: agent.email,
        solanaAddress: agent.solanaAddress,
      },
      count: transactions.length,
      totalCount,
      limit,
      offset,
      actionSummary: stats.map((s) => ({
        action: s.action,
        count: s._count,
        totalAmount: s._sum.amount || 0,
      })),
      transactions: transactions.map((tx) => ({
        id: tx.id,
        action: tx.action,
        asset: tx.asset,
        amount: tx.amount,
        from: tx.from,
        to: tx.to,
        signature: tx.signature,
        status: tx.status,
        metadata: tx.metadata,
        createdAt: tx.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    logger.error("Failed to retrieve agent transactions", { error: String(err) });
    return error(c, "Failed to retrieve agent transactions.", 500, { error: String(err) });
  }
});

// =============================================================================
// DASHBOARD OVERVIEW
// =============================================================================

// GET /admin/dashboard
// Get overall platform stats and health
admin.get("/dashboard", async (c) => {
  try {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      // Agent stats
      totalAgents,
      newAgentsToday,
      newAgentsWeek,
      activeAgentsToday,
      // Transaction stats
      totalTransactions,
      transactionsToday,
      transactionsWeek,
      // Transfer stats
      transferStats,
      transfersToday,
      // Trade stats
      tradeStats,
      tradesToday,
      // Failure stats
      failedTransactionsToday,
      rejectedByPolicyToday,
      // Prediction stats
      predictionOrderCount,
      predictionVolumeStats,
      // Liquidity stats
      liquidityPositionCount,
      activePositions,
    ] = await Promise.all([
      // Agents
      db.agent.count(),
      db.agent.count({ where: { createdAt: { gte: oneDayAgo } } }),
      db.agent.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
      db.agent.count({ where: { lastActiveAt: { gte: oneDayAgo } } }),
      // Transactions
      db.auditLog.count(),
      db.auditLog.count({ where: { createdAt: { gte: oneDayAgo } } }),
      db.auditLog.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
      // Transfers
      db.auditLog.aggregate({
        where: { action: "transfer", status: "confirmed" },
        _count: true,
        _sum: { amount: true },
      }),
      db.auditLog.aggregate({
        where: { action: "transfer", status: "confirmed", createdAt: { gte: oneDayAgo } },
        _count: true,
        _sum: { amount: true },
      }),
      // Trades
      db.auditLog.aggregate({
        where: { action: "trade", status: "confirmed" },
        _count: true,
      }),
      db.auditLog.aggregate({
        where: { action: "trade", status: "confirmed", createdAt: { gte: oneDayAgo } },
        _count: true,
      }),
      // Failures
      db.auditLog.count({
        where: { status: "failed", createdAt: { gte: oneDayAgo } },
      }),
      db.auditLog.count({
        where: { status: "rejected_by_policy", createdAt: { gte: oneDayAgo } },
      }),
      // Predictions
      db.predictionOrder.count(),
      db.predictionOrder.aggregate({
        _sum: { totalCost: true, feeCents: true },
      }),
      // Liquidity
      db.liquidityPosition.count(),
      db.liquidityPosition.count({ where: { status: "active" } }),
    ]);

    // Get top agents by activity (last 30 days)
    const topAgentsByActivity = await db.auditLog.groupBy({
      by: ["agentId"],
      where: { createdAt: { gte: thirtyDaysAgo } },
      _count: true,
      orderBy: { _count: { agentId: "desc" } },
      take: 10,
    });

    const topAgentIds = topAgentsByActivity.map((a) => a.agentId);
    const topAgents = await db.agent.findMany({
      where: { id: { in: topAgentIds } },
      select: { id: true, email: true },
    });
    const topAgentMap = new Map(topAgents.map((a) => [a.id, a]));

    return success(c, "Dashboard stats retrieved.", {
      agents: {
        total: totalAgents,
        newToday: newAgentsToday,
        newThisWeek: newAgentsWeek,
        activeToday: activeAgentsToday,
      },
      transactions: {
        total: totalTransactions,
        today: transactionsToday,
        thisWeek: transactionsWeek,
        failedToday: failedTransactionsToday,
        rejectedByPolicyToday: rejectedByPolicyToday,
      },
      transfers: {
        total: {
          count: transferStats._count,
          volume: transferStats._sum.amount || 0,
        },
        today: {
          count: transfersToday._count,
          volume: transfersToday._sum.amount || 0,
        },
      },
      trades: {
        total: {
          count: tradeStats._count,
        },
        today: {
          count: tradesToday._count,
        },
      },
      predictions: {
        totalOrders: predictionOrderCount,
        totalVolumeCents: Math.abs(predictionVolumeStats._sum.totalCost || 0),
        totalFeesCollectedCents: predictionVolumeStats._sum.feeCents || 0,
      },
      liquidity: {
        totalPositions: liquidityPositionCount,
        activePositions: activePositions,
      },
      topAgents: topAgentsByActivity.map((a) => ({
        agentId: a.agentId,
        email: topAgentMap.get(a.agentId)?.email,
        transactionCount: a._count,
      })),
    });
  } catch (err) {
    logger.error("Failed to retrieve dashboard stats", { error: String(err) });
    return error(c, "Failed to retrieve dashboard stats.", 500, { error: String(err) });
  }
});

// =============================================================================
// ADMIN WALLET OPERATIONS (Fee-Free)
// Transfer and swap from admin wallets without platform fees
// =============================================================================

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

// POST /admin/wallet/transfer
// Admin transfer SOL or SPL tokens without platform fees
admin.post(
  "/wallet/transfer",
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

      // Log admin action
      await createAuditLog({
        agentId: "admin",
        action: "admin_transfer",
        asset: assetLabel,
        amount,
        from: fromAddress,
        to,
        signature,
        status: "confirmed",
        metadata: { walletType, adminEmail, noFee: true },
      });

      logger.info("Admin transfer completed", { signature, walletType, amount, to, adminEmail });

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

// POST /admin/wallet/swap
// Admin swap tokens via Jupiter without platform fees
admin.post(
  "/wallet/swap",
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

      // Log admin action
      await createAuditLog({
        agentId: "admin",
        action: "admin_swap",
        asset: fromResolved.symbol,
        amount,
        to: toResolved.symbol,
        signature,
        status: "confirmed",
        metadata: {
          walletType,
          adminEmail,
          inputMint,
          outputMint,
          outputAmount: parseFloat(outputAmount),
          noFee: true,
        },
      });

      logger.info("Admin swap completed", { signature, walletType, from, to, amount, adminEmail });

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

// GET /admin/wallet/balances
// Get balances for all admin wallets
admin.get("/wallet/balances", async (c) => {
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

// =============================================================================
// JUPITER REFERRAL FEE CLAIMING
// Claim accumulated swap fees from Jupiter referral program
// =============================================================================

// SOL mint address (wrapped SOL)
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

// GET /admin/referral/status
// Check Jupiter referral account status and unclaimed fees
admin.get("/referral/status", async (c) => {
  try {
    const referralAccountAddress = config.JUPITER_REFERRAL_ACCOUNT;
    const feeWalletAddress = config.KNOT_FEE_WALLET_ADDRESS;

    if (!referralAccountAddress) {
      return error(c, "Jupiter referral account not configured. Set JUPITER_REFERRAL_ACCOUNT in env.", 503);
    }

    logger.info("Checking Jupiter referral status", { referralAccountAddress });

    // Initialize the ReferralProvider
    const provider = new ReferralProvider(connection);

    // Get all referral token accounts (where fees accumulate)
    // The SDK takes a string address, not PublicKey
    const { tokenAccounts, token2022Accounts } = await provider.getReferralTokenAccounts(referralAccountAddress);
    const allTokenAccounts = [...tokenAccounts, ...token2022Accounts];

    logger.info("Found referral token accounts", {
      tokenAccounts: tokenAccounts.length,
      token2022Accounts: token2022Accounts.length
    });

    // Collect unclaimed balances
    const unclaimedFees: {
      mint: string;
      symbol: string;
      amount: number;
      amountRaw: string;
      decimals: number;
      isToken2022: boolean;
    }[] = [];

    // Known mints for display
    const knownMints: Record<string, { symbol: string; decimals: number }> = {
      "So11111111111111111111111111111111111111112": { symbol: "SOL", decimals: 9 },
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": { symbol: "USDC", decimals: 6 },
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": { symbol: "USDT", decimals: 6 },
    };

    for (let i = 0; i < allTokenAccounts.length; i++) {
      const tokenAccount = allTokenAccounts[i];
      const isToken2022 = i >= tokenAccounts.length;
      const mintStr = tokenAccount.account.mint.toBase58();
      const amountRaw = tokenAccount.account.amount;

      // Skip if no balance
      if (amountRaw === BigInt(0)) continue;

      let symbol = "UNKNOWN";
      let decimals = 9; // Default to SOL decimals

      if (knownMints[mintStr]) {
        symbol = knownMints[mintStr].symbol;
        decimals = knownMints[mintStr].decimals;
      } else {
        // Try to fetch mint info
        try {
          const mintPubkey = tokenAccount.account.mint;
          const mintInfo = await getMint(
            connection,
            mintPubkey,
            undefined,
            isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
          );
          decimals = mintInfo.decimals;
        } catch {
          // Keep default
        }
      }

      const amount = Number(amountRaw) / Math.pow(10, decimals);

      unclaimedFees.push({
        mint: mintStr,
        symbol,
        amount,
        amountRaw: amountRaw.toString(),
        decimals,
        isToken2022,
      });
    }

    return success(c, "Jupiter referral status retrieved.", {
      referralAccount: {
        address: referralAccountAddress,
        feeTiers: {
          description: "Tiered fees based on trade USD value",
          tiers: [
            { range: "< $6.25", bps: 255, net: "2.04%" },
            { range: "$6.25-$12.50", bps: 200, net: "1.60%" },
            { range: "≥ $12.50", bps: 100, net: "0.80%" },
          ],
        },
      },
      feeWallet: feeWalletAddress || "not configured",
      tokenAccountsCount: allTokenAccounts.length,
      unclaimedFees,
      totalUnclaimedTokens: unclaimedFees.length,
    });
  } catch (err) {
    logger.error("Failed to check referral status", { error: String(err) });
    return error(c, `Failed to check referral status: ${String(err)}`, 500);
  }
});

// POST /admin/referral/claim
// Claim all accumulated Jupiter referral fees
admin.post("/referral/claim", async (c) => {
  const adminEmail = (c.get as (key: string) => string | undefined)("adminEmail") || "unknown";

  try {
    const referralAccountAddress = config.JUPITER_REFERRAL_ACCOUNT;
    const feeWalletAddress = config.KNOT_FEE_WALLET_ADDRESS;

    if (!referralAccountAddress) {
      return error(c, "Jupiter referral account not configured. Set JUPITER_REFERRAL_ACCOUNT in env.", 503);
    }

    if (!feeWalletAddress) {
      return error(c, "Fee wallet not configured. Set KNOT_FEE_WALLET_ADDRESS in env.", 503);
    }

    logger.info("Starting Jupiter referral fee claim", { referralAccountAddress, feeWalletAddress, adminEmail });

    const referralAccountPubkey = new PublicKey(referralAccountAddress);
    const feeWalletPubkey = new PublicKey(feeWalletAddress);

    // Initialize the ReferralProvider
    const provider = new ReferralProvider(connection);

    // Get all referral token accounts
    const { tokenAccounts, token2022Accounts } = await provider.getReferralTokenAccounts(referralAccountAddress);
    const allTokenAccounts = [...tokenAccounts, ...token2022Accounts];

    if (allTokenAccounts.length === 0) {
      return success(c, "No referral token accounts found. Nothing to claim.", {
        claimed: [],
        totalClaimed: 0,
      });
    }

    // Filter to only accounts with balance
    const accountsWithBalance = allTokenAccounts.filter(
      (ta) => ta.account.amount > BigInt(0)
    );

    if (accountsWithBalance.length === 0) {
      return success(c, "All referral token accounts are empty. Nothing to claim.", {
        claimed: [],
        totalClaimed: 0,
      });
    }

    logger.info("Found accounts with balance to claim", { count: accountsWithBalance.length });

    const claimedFees: {
      mint: string;
      symbol: string;
      amount: number;
      signature: string;
    }[] = [];

    // Known mints for display
    const knownMints: Record<string, { symbol: string; decimals: number }> = {
      "So11111111111111111111111111111111111111112": { symbol: "SOL", decimals: 9 },
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": { symbol: "USDC", decimals: 6 },
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": { symbol: "USDT", decimals: 6 },
    };

    // Get claim transactions for each token
    for (let i = 0; i < accountsWithBalance.length; i++) {
      const tokenAccount = accountsWithBalance[i];
      const isToken2022 = i >= tokenAccounts.filter((ta) => ta.account.amount > BigInt(0)).length;
      const mintStr = tokenAccount.account.mint.toBase58();
      const amountRaw = tokenAccount.account.amount;

      let symbol = "UNKNOWN";
      let decimals = 9;

      if (knownMints[mintStr]) {
        symbol = knownMints[mintStr].symbol;
        decimals = knownMints[mintStr].decimals;
      } else {
        try {
          const mintInfo = await getMint(
            connection,
            tokenAccount.account.mint,
            undefined,
            isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
          );
          decimals = mintInfo.decimals;
        } catch {
          // Keep default
        }
      }

      const amount = Number(amountRaw) / Math.pow(10, decimals);

      try {
        // Build claim transaction using the SDK
        // Use claimV2 for Token-2022 tokens, claim for regular tokens
        const claimTx = isToken2022
          ? await provider.claimV2({
              payerPubKey: feeWalletPubkey,
              referralAccountPubKey: referralAccountPubkey,
              mint: tokenAccount.account.mint,
            })
          : await provider.claim({
              payerPubKey: feeWalletPubkey,
              referralAccountPubKey: referralAccountPubkey,
              mint: tokenAccount.account.mint,
            });

        logger.info("Claim transaction built", { mint: mintStr, symbol, amount, isToken2022 });

        // The SDK returns a VersionedTransaction directly
        // Try to broadcast (this will only work if we have proper signing setup)
        const signature = await signAndBroadcastAdmin(claimTx, feeWalletAddress);

        claimedFees.push({
          mint: mintStr,
          symbol,
          amount,
          signature,
        });

        logger.info("Successfully claimed referral fees", { mint: mintStr, symbol, amount, signature });

        // Log to audit
        await createAuditLog({
          agentId: "admin",
          action: "referral_claim",
          asset: symbol,
          amount,
          to: feeWalletAddress,
          signature,
          status: "confirmed",
          metadata: {
            mint: mintStr,
            referralAccount: referralAccountAddress,
            adminEmail,
            isToken2022,
          },
        });

      } catch (claimErr) {
        logger.error("Failed to claim for token", { mint: mintStr, symbol, error: String(claimErr) });
        // Continue to try other tokens
      }
    }

    if (claimedFees.length === 0) {
      return error(
        c,
        "Failed to claim any referral fees. The fee wallet may not have authority over the referral account. " +
        "Ensure KNOT_FEE_WALLET_ADDRESS is set as the referral account authority on Jupiter's dashboard.",
        500
      );
    }

    return success(c, `Successfully claimed ${claimedFees.length} referral fee token(s).`, {
      claimed: claimedFees,
      totalClaimed: claimedFees.length,
      feeWallet: feeWalletAddress,
    });

  } catch (err) {
    logger.error("Failed to claim referral fees", { error: String(err) });
    return error(c, `Failed to claim referral fees: ${String(err)}`, 500);
  }
});

export { admin };
