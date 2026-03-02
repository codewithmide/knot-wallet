import { Hono } from "hono";
import { db } from "../../db/prisma.js";
import { error, success } from "../../utils/response.js";
import { logger } from "../../utils/logger.js";

const dashboardRoutes = new Hono();

// =============================================================================
// Dashboard Overview
// =============================================================================

// GET /dashboard
dashboardRoutes.get("/", async (c) => {
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

    // Filter out null agentIds (admin actions) from top agents
    const topAgentIds = topAgentsByActivity
      .map((a) => a.agentId)
      .filter((id): id is string => id !== null);
    const topAgents = topAgentIds.length > 0 ? await db.agent.findMany({
      where: { id: { in: topAgentIds } },
      select: { id: true, email: true },
    }) : [];
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
      topAgents: topAgentsByActivity
        .filter((a) => a.agentId !== null)
        .map((a) => ({
          agentId: a.agentId,
          email: topAgentMap.get(a.agentId!)?.email,
          transactionCount: a._count,
        })),
    });
  } catch (err) {
    logger.error("Failed to retrieve dashboard stats", { error: String(err) });
    return error(c, "Failed to retrieve dashboard stats.", 500, { error: String(err) });
  }
});

export { dashboardRoutes };
