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
import { logger } from "../../utils/logger.js";

const agentsRoutes = new Hono();

// =============================================================================
// List Agents
// =============================================================================

// GET /agents
agentsRoutes.get("/", async (c) => {
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

// =============================================================================
// Agent Detail
// =============================================================================

// GET /agents/:id
agentsRoutes.get("/:id", async (c) => {
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

export { agentsRoutes };
