import { Hono } from "hono";
import { createDecipheriv } from "crypto";
import { db } from "../db/prisma.js";
import { config } from "../config.js";
import { error, success } from "../utils/response.js";
import { connection } from "../turnkey/signer.js";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";

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

function verifyAdminAuth(token: string | undefined): string | null {
  if (!token) {
    return "Missing admin token";
  }

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
  } catch (err) {
    return `Invalid admin token: ${err}`;
  }
}

// Admin auth middleware
admin.use("*", async (c, next) => {
  const token = c.req.header(ADMIN_TOKEN_HEADER);
  const errorMessage = verifyAdminAuth(token);

  if (errorMessage) {
    return error(c, "Unauthorized admin request.", 401, { reason: errorMessage });
  }

  await next();
});

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
// View all agent prediction balances
admin.get("/predictions/balances", async (c) => {
  try {
    const balances = await db.predictionBalance.findMany({
      where: { balance: { gt: 0 } },
      orderBy: { balance: "desc" },
    });

    // Get unique agent IDs and fetch agent info
    const agentIds = [...new Set(balances.map((b) => b.agentId))];
    const agents = await db.agent.findMany({
      where: { id: { in: agentIds } },
      select: { id: true, email: true, solanaAddress: true },
    });
    const agentMap = new Map(agents.map((a) => [a.id, a]));

    const totalBalance = await db.predictionBalance.aggregate({
      _sum: { balance: true },
    });

    return success(c, "Agent balances retrieved.", {
      count: balances.length,
      totalBalanceCents: totalBalance._sum.balance || 0,
      totalBalanceDollars: (totalBalance._sum.balance || 0) / 100,
      balances: balances.map((b) => {
        const agent = agentMap.get(b.agentId);
        return {
          agentId: b.agentId,
          agentEmail: agent?.email,
          balanceCents: b.balance,
          balanceDollars: b.balance / 100,
          updatedAt: b.updatedAt.toISOString(),
        };
      }),
    });
  } catch (err) {
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

export { admin };
