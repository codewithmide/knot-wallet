import { Hono } from "hono";
import { db } from "../../db/prisma.js";
import { error, success } from "../../utils/response.js";
import { connection } from "../../turnkey/signer.js";
import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { USDC_MINT } from "./auth.js";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { kalshiRequest, type BalanceResponse } from "../../kalshi/client.js";

const predictionsRoutes = new Hono();

// =============================================================================
// Failed Transfers (Critical - needs manual intervention)
// =============================================================================

// GET /predictions/failed-transfers
predictionsRoutes.get("/failed-transfers", async (c) => {
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

// GET /predictions/deposits
predictionsRoutes.get("/deposits", async (c) => {
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

// GET /predictions/withdrawals
predictionsRoutes.get("/withdrawals", async (c) => {
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

// GET /predictions/orders
predictionsRoutes.get("/orders", async (c) => {
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

// GET /predictions/positions
predictionsRoutes.get("/positions", async (c) => {
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

// GET /predictions/wallet
predictionsRoutes.get("/wallet", async (c) => {
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

// GET /predictions/balances
predictionsRoutes.get("/balances", async (c) => {
  try {
    logger.info("Fetching prediction activity by agent");

    // Get all agents who have any prediction activity
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
        internalBalanceCents: balance?.balance || 0,
        internalBalanceDollars: (balance?.balance || 0) / 100,
        totalDepositsUSDC: deposits?._sum.usdcAmount || 0,
        depositCount: deposits?._count || 0,
        totalOrderVolumeCents: Math.abs(orders?._sum.totalCost || 0),
        totalFeesPaidCents: orders?._sum.feeCents || 0,
        orderCount: orders?._count || 0,
        openPositionCount: positions?._count || 0,
        openPositionCostCents: positions?._sum.totalCost || 0,
        openContractsCount: positions?._sum.quantity || 0,
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

// GET /predictions/summary
predictionsRoutes.get("/summary", async (c) => {
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

export { predictionsRoutes };
