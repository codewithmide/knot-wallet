import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { authMiddleware } from "../auth/middleware.js";
import { success, error } from "../utils/response.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

// Market discovery (read-only, direct from Kalshi)
import {
  getCategories,
  getSportsFilters,
  listMarkets,
  getMarket,
  listEvents,
  getEvent,
  listSeries,
  getSeries,
  getOrderbook,
  listMilestones,
  getMilestone,
  listStructuredTargets,
  getStructuredTarget,
} from "../actions/kalshi.js";

// Custodial prediction service
import {
  getPredictionBalance,
  withdrawFromPredictions,
  buyPrediction,
  sellPrediction,
  getAgentPositions,
  getAgentOrders,
  isAdminWalletConfigured,
} from "../services/predictions/index.js";

import { agentActionRateLimit } from "../utils/rate-limit.js";
import { idempotency } from "../utils/idempotency.js";

const predictions = new Hono();

// Check if Kalshi is configured
predictions.use("*", async (c, next) => {
  if (!config.KALSHI_API_KEY_ID || !config.KALSHI_RSA_PRIVATE_KEY) {
    return error(c, "Kalshi prediction markets are not configured", 503);
  }
  await next();
});

// All prediction routes require authentication
predictions.use("*", authMiddleware);
predictions.use("*", agentActionRateLimit);

// Idempotency protection on mutation routes (withdraw, buy, sell)
predictions.use("/withdraw", idempotency);
predictions.use("/buy", idempotency);
predictions.use("/sell", idempotency);

// =============================================================================
// Market Discovery (Read-only)
// =============================================================================

// GET /predictions/categories
// Get all available categories and their tags
predictions.get("/categories", async (c) => {
  try {
    const categories = await getCategories();
    return success(c, "Categories retrieved successfully.", categories);
  } catch (err) {
    logger.error("Failed to get categories", { error: err });
    return error(c, `Failed to get categories: ${err}`, 500);
  }
});

// GET /predictions/sports
// Get sports filters with competitions and scopes
predictions.get("/sports", async (c) => {
  try {
    const sportsFilters = await getSportsFilters();
    return success(c, "Sports filters retrieved successfully.", sportsFilters);
  } catch (err) {
    logger.error("Failed to get sports filters", { error: err });
    return error(c, `Failed to get sports filters: ${err}`, 500);
  }
});

// GET /predictions/markets
// List available prediction markets
predictions.get("/markets", async (c) => {
  try {
    const status = c.req.query("status") as
      | "unopened"
      | "open"
      | "closed"
      | "settled"
      | undefined;
    const eventTicker = c.req.query("event_ticker");
    const seriesTicker = c.req.query("series_ticker");
    const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!) : 50;
    const cursor = c.req.query("cursor");
    const tradeableOnly = c.req.query("tradeable_only") === "true";

    const result = await listMarkets({
      status,
      eventTicker,
      seriesTicker,
      limit,
      cursor,
    });

    // Filter out illiquid markets if requested
    if (tradeableOnly) {
      result.markets = result.markets.filter((m) => {
        const isOpen = m.status === "open" || m.status === "active";
        const hasLiquidity = (m.liquidity as number) > 0;
        return isOpen && hasLiquidity;
      });
    }

    return success(c, "Markets retrieved successfully.", result);
  } catch (err) {
    logger.error("Failed to list markets", { error: err });
    return error(c, `Failed to list markets: ${err}`, 500);
  }
});

// GET /predictions/markets/:ticker
// Get details for a specific market
predictions.get("/markets/:ticker", async (c) => {
  try {
    const ticker = c.req.param("ticker");
    const market = await getMarket(ticker);
    return success(c, "Market retrieved successfully.", market);
  } catch (err) {
    logger.error("Failed to get market", { error: err });
    return error(c, `Failed to get market: ${err}`, 500);
  }
});

// GET /predictions/markets/:ticker/orderbook
// Get orderbook for a market
predictions.get("/markets/:ticker/orderbook", async (c) => {
  try {
    const ticker = c.req.param("ticker");
    const depth = c.req.query("depth") ? parseInt(c.req.query("depth")!) : undefined;
    const orderbook = await getOrderbook(ticker, depth);
    return success(c, "Orderbook retrieved successfully.", orderbook);
  } catch (err) {
    logger.error("Failed to get orderbook", { error: err });
    return error(c, `Failed to get orderbook: ${err}`, 500);
  }
});

// GET /predictions/events
// List events (groups of related markets)
predictions.get("/events", async (c) => {
  try {
    const status = c.req.query("status") as "open" | "closed" | "settled" | undefined;
    const seriesTicker = c.req.query("series_ticker");
    const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!) : 20;
    const cursor = c.req.query("cursor");

    const result = await listEvents({ status, seriesTicker, limit, cursor });

    return success(c, "Events retrieved successfully.", result);
  } catch (err) {
    logger.error("Failed to list events", { error: err });
    return error(c, `Failed to list events: ${err}`, 500);
  }
});

// GET /predictions/events/:eventTicker
// Get a specific event
predictions.get("/events/:eventTicker", async (c) => {
  try {
    const eventTicker = c.req.param("eventTicker");
    const event = await getEvent(eventTicker);
    return success(c, "Event retrieved successfully.", event);
  } catch (err) {
    logger.error("Failed to get event", { error: err });
    return error(c, `Failed to get event: ${err}`, 500);
  }
});

// GET /predictions/series
// List all series
predictions.get("/series", async (c) => {
  try {
    const category = c.req.query("category");
    const tags = c.req.query("tags");
    const includeProductMetadata = c.req.query("include_product_metadata") === "true";
    const includeVolume = c.req.query("include_volume") === "true";
    const minUpdatedTs = c.req.query("min_updated_ts") ? parseInt(c.req.query("min_updated_ts")!) : undefined;
    const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!) : 100;
    const cursor = c.req.query("cursor");

    const result = await listSeries({
      category,
      tags,
      includeProductMetadata: c.req.query("include_product_metadata") ? includeProductMetadata : undefined,
      includeVolume: c.req.query("include_volume") ? includeVolume : undefined,
      minUpdatedTs,
      limit,
      cursor,
    });

    return success(c, "Series retrieved successfully.", result);
  } catch (err) {
    logger.error("Failed to list series", { error: err });
    return error(c, `Failed to list series: ${err}`, 500);
  }
});

// GET /predictions/series/:seriesTicker
// Get a specific series
predictions.get("/series/:seriesTicker", async (c) => {
  try {
    const seriesTicker = c.req.param("seriesTicker");
    const series = await getSeries(seriesTicker);
    return success(c, "Series retrieved successfully.", series);
  } catch (err) {
    logger.error("Failed to get series", { error: err });
    return error(c, `Failed to get series: ${err}`, 500);
  }
});

// GET /predictions/milestones
// List milestones (upcoming games, matches, events)
// category = top-level (e.g., "Sports", "Crypto"), competition = specific (e.g., "Champions League")
predictions.get("/milestones", async (c) => {
  try {
    const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!) : 100;
    // Default to start of current day (UTC) so only upcoming milestones are returned
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const minimumStartDate = c.req.query("minimum_start_date") ?? todayStart.toISOString();
    const category = c.req.query("category");
    const competition = c.req.query("competition");
    const type = c.req.query("type");
    const relatedEventTicker = c.req.query("related_event_ticker");
    const cursor = c.req.query("cursor");
    const minUpdatedTs = c.req.query("min_updated_ts") ? parseInt(c.req.query("min_updated_ts")!) : undefined;

    const result = await listMilestones({
      limit,
      minimumStartDate,
      category,
      competition,
      type,
      relatedEventTicker,
      cursor,
      minUpdatedTs,
    });

    return success(c, "Milestones retrieved successfully.", result);
  } catch (err) {
    logger.error("Failed to list milestones", { error: err });
    return error(c, `Failed to list milestones: ${err}`, 500);
  }
});

// GET /predictions/milestones/:milestoneId
// Get a specific milestone by ID
predictions.get("/milestones/:milestoneId", async (c) => {
  try {
    const milestoneId = c.req.param("milestoneId");
    const milestone = await getMilestone(milestoneId);
    return success(c, "Milestone retrieved successfully.", milestone);
  } catch (err) {
    logger.error("Failed to get milestone", { error: err });
    return error(c, `Failed to get milestone: ${err}`, 500);
  }
});

// GET /predictions/structured-targets
// List structured targets with optional competition/type filtering
predictions.get("/structured-targets", async (c) => {
  try {
    const type = c.req.query("type");
    const competition = c.req.query("competition");
    const pageSize = c.req.query("page_size") ? parseInt(c.req.query("page_size")!) : 100;
    const cursor = c.req.query("cursor");

    const result = await listStructuredTargets({
      type,
      competition,
      pageSize,
      cursor,
    });

    return success(c, "Structured targets retrieved successfully.", result);
  } catch (err) {
    logger.error("Failed to list structured targets", { error: err });
    return error(c, `Failed to list structured targets: ${err}`, 500);
  }
});

// GET /predictions/structured-targets/:structuredTargetId
// Get a specific structured target by ID
predictions.get("/structured-targets/:structuredTargetId", async (c) => {
  try {
    const structuredTargetId = c.req.param("structuredTargetId");
    const target = await getStructuredTarget(structuredTargetId);
    return success(c, "Structured target retrieved successfully.", target);
  } catch (err) {
    logger.error("Failed to get structured target", { error: err });
    return error(c, `Failed to get structured target: ${err}`, 500);
  }
});

// =============================================================================
// Agent Balance & Account
// =============================================================================

// GET /predictions/balance
// Get agent's prediction balance
predictions.get("/balance", async (c) => {
  try {
    const agent = c.get("agent");
    const balance = await getPredictionBalance(agent.id);
    return success(c, "Balance retrieved successfully.", balance);
  } catch (err) {
    logger.error("Failed to get prediction balance", { error: err });
    return error(c, `Failed to get balance: ${err}`, 500);
  }
});

// POST /predictions/withdraw
// Withdraw from prediction balance to USDC in agent's wallet
// Transfers USDC from admin wallet to agent wallet
predictions.post(
  "/withdraw",
  zValidator(
    "json",
    z.object({
      amountDollars: z.number().positive(),
    })
  ),
  async (c) => {
    try {
      if (!isAdminWalletConfigured()) {
        return error(c, "Prediction market withdrawals are not configured", 503);
      }

      const agent = c.get("agent");
      const { amountDollars } = c.req.valid("json");
      const usdCents = Math.floor(amountDollars * 100);

      const result = await withdrawFromPredictions(
        agent.id,
        usdCents,
        agent.solanaAddress
      );

      return success(c, "Withdrawal completed successfully.", {
        ...result,
        usdcAmount: result.usdcAmount,
        newBalanceDollars: (await getPredictionBalance(agent.id)).balanceDollars,
      });
    } catch (err) {
      logger.error("Failed to process withdrawal", { error: err });
      return error(c, `${err}`, 400);
    }
  }
);

// =============================================================================
// Trading
// =============================================================================

// POST /predictions/buy
// Buy prediction contracts (market order)
// Transfers USDC from agent wallet to admin, then executes buy on Kalshi
predictions.post(
  "/buy",
  zValidator(
    "json",
    z.object({
      ticker: z.string().min(1),
      side: z.enum(["yes", "no"]),
      count: z.number().int().positive(),
    })
  ),
  async (c) => {
    try {
      if (!isAdminWalletConfigured()) {
        return error(c, "Prediction markets are not configured", 503);
      }

      const agent = c.get("agent");
      const { ticker, side, count } = c.req.valid("json");

      const result = await buyPrediction(
        agent.id,
        ticker,
        side,
        count,
        agent.solanaAddress,
        agent.turnkeySubOrgId
      );

      return success(c, "Order placed successfully.", {
        ...result,
        totalCostDollars: result.totalCost / 100,
        feeDollars: result.feeCents / 100,
      });
    } catch (err) {
      logger.error("Failed to buy prediction", { error: err });
      return error(c, `${err}`, 400);
    }
  }
);

// POST /predictions/sell
// Sell prediction contracts (market order)
// Executes sell on Kalshi, then transfers net proceeds to agent wallet
predictions.post(
  "/sell",
  zValidator(
    "json",
    z.object({
      ticker: z.string().min(1),
      side: z.enum(["yes", "no"]),
      count: z.number().int().positive(),
    })
  ),
  async (c) => {
    try {
      if (!isAdminWalletConfigured()) {
        return error(c, "Prediction markets are not configured", 503);
      }

      const agent = c.get("agent");
      const { ticker, side, count } = c.req.valid("json");

      const result = await sellPrediction(
        agent.id,
        ticker,
        side,
        count,
        agent.solanaAddress
      );

      return success(c, "Sell order placed successfully. Proceeds transferred to your wallet.", {
        ...result,
        totalProceedsDollars: result.totalProceeds / 100,
        feeDollars: result.feeCents / 100,
      });
    } catch (err) {
      logger.error("Failed to sell prediction", { error: err });
      return error(c, `${err}`, 400);
    }
  }
);

// =============================================================================
// Positions & Orders
// =============================================================================

// GET /predictions/positions
// Get agent's prediction positions
predictions.get("/positions", async (c) => {
  try {
    const agent = c.get("agent");
    const settled = c.req.query("settled");

    const positions = await getAgentPositions(agent.id, {
      settled: settled === "true" ? true : settled === "false" ? false : undefined,
    });

    return success(c, "Positions retrieved successfully.", {
      positions,
      summary: {
        totalPositions: positions.length,
        openPositions: positions.filter((p) => !p.settled).length,
        settledPositions: positions.filter((p) => p.settled).length,
      },
    });
  } catch (err) {
    logger.error("Failed to get positions", { error: err });
    return error(c, `Failed to get positions: ${err}`, 500);
  }
});

// GET /predictions/orders
// Get agent's order history
predictions.get("/orders", async (c) => {
  try {
    const agent = c.get("agent");
    const ticker = c.req.query("ticker");
    const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!) : 50;

    const orders = await getAgentOrders(agent.id, { ticker, limit });

    return success(c, "Orders retrieved successfully.", { orders });
  } catch (err) {
    logger.error("Failed to get orders", { error: err });
    return error(c, `Failed to get orders: ${err}`, 500);
  }
});

export { predictions };
