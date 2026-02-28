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
  addLiquidity,
  removeLiquidity,
  claimRewards,
  isMeteoraAdminConfigured,
} from "../services/liquidity.js";
import { db } from "../db/prisma.js";
import { success, error } from "../utils/response.js";
import { resolveTokenMint, TokenNotFoundError } from "../utils/tokens.js";
import { createAuditLog } from "../utils/audit.js";

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

// POST /wallets/me/actions/add-liquidity
// Add liquidity to a DLMM pool (custodial: agent transfers tokens to admin, admin provides liquidity)
actions.post(
  "/actions/add-liquidity",
  zValidator(
    "json",
    z.object({
      pool: z.string().min(32).max(44),
      amountX: z.number().positive(),
      amountY: z.number().positive().optional(),
      strategy: z.enum(["spot", "curve", "bidAsk"]).default("spot"),
      rangeWidth: z.number().int().min(1).max(100).default(10),
    })
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

    return success(c, "Liquidity added successfully. A 1% entry fee applies.", result);
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

export { actions };
