import { Hono } from "hono";
import { db } from "../../db/prisma.js";
import { error, success } from "../../utils/response.js";
import { logger } from "../../utils/logger.js";

const transactionsRoutes = new Hono();

// =============================================================================
// All Transactions
// =============================================================================

// GET /transactions
transactionsRoutes.get("/", async (c) => {
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

    // Get agent info for the transactions (filter out null agentIds for admin actions)
    const agentIds = [...new Set(transactions.map((t) => t.agentId).filter((id): id is string => id !== null))];
    const agents = agentIds.length > 0 ? await db.agent.findMany({
      where: { id: { in: agentIds } },
      select: { id: true, email: true, solanaAddress: true },
    }) : [];
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
        const agent = tx.agentId ? agentMap.get(tx.agentId) : null;
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

// =============================================================================
// Agent-Specific Transactions
// =============================================================================

// GET /transactions/agent/:agentId
transactionsRoutes.get("/agent/:agentId", async (c) => {
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

export { transactionsRoutes };
