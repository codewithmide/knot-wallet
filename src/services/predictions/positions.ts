import { db } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";
import {
  kalshiRequest,
  type KalshiMarket,
} from "../../kalshi/client.js";
import type { AgentPosition } from "./types.js";

// =============================================================================
// Position Tracking
// =============================================================================

/**
 * Get agent's prediction positions.
 */
export async function getAgentPositions(
  agentId: string,
  options?: { settled?: boolean }
): Promise<AgentPosition[]> {
  const { settled } = options || {};

  const positions = await db.predictionPosition.findMany({
    where: {
      agentId,
      ...(settled !== undefined ? { settled } : {}),
    },
    orderBy: { updatedAt: "desc" },
  });

  // Fetch current prices for open positions
  const positionsWithPrices: AgentPosition[] = [];

  for (const pos of positions) {
    let currentPrice: number | null = null;
    let currentValue: number | null = null;
    let unrealizedPnl: number | null = null;

    if (!pos.settled) {
      try {
        const market = await kalshiRequest<{ market: KalshiMarket }>(
          "GET",
          `/markets/${pos.ticker}`
        );
        currentPrice =
          pos.side === "yes" ? market.market.yes_bid : market.market.no_bid;
        if (currentPrice) {
          currentValue = currentPrice * pos.quantity;
          unrealizedPnl = currentValue - pos.totalCost;
        }
      } catch {
        // Market may be closed/settled, skip price fetch
      }
    }

    positionsWithPrices.push({
      ticker: pos.ticker,
      eventTicker: pos.eventTicker,
      side: pos.side as "yes" | "no",
      quantity: pos.quantity,
      averageCost: pos.averageCost,
      totalCost: pos.totalCost,
      currentPrice,
      currentValue,
      unrealizedPnl,
      settled: pos.settled,
      settlementResult: pos.settlementResult,
      settlementPayout: pos.settlementPayout,
    });
  }

  return positionsWithPrices;
}

/**
 * Get agent's order history with market and event titles.
 */
export async function getAgentOrders(
  agentId: string,
  options?: { ticker?: string; limit?: number }
) {
  const { ticker, limit = 50 } = options || {};

  const orders = await db.predictionOrder.findMany({
    where: {
      agentId,
      ...(ticker ? { ticker } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  // Fetch market and event info for all orders
  const marketCache: Record<string, { title: string; eventTicker: string }> = {};
  const eventCache: Record<string, string> = {}; // eventTicker -> title

  const ordersWithTitles = await Promise.all(
    orders.map(async (o) => {
      let marketTitle = "Unknown Market";
      let eventTitle = "Unknown Event";

      try {
        // Fetch market info (cached by ticker)
        if (!marketCache[o.ticker]) {
          const market = await kalshiRequest<{ market: KalshiMarket }>(
            "GET",
            `/markets/${o.ticker}`
          );
          marketCache[o.ticker] = {
            title: market.market.title,
            eventTicker: market.market.event_ticker,
          };
        }

        marketTitle = marketCache[o.ticker].title;
        const eventTicker = marketCache[o.ticker].eventTicker;

        // Fetch event info (cached by event_ticker)
        if (!eventCache[eventTicker]) {
          const event = await kalshiRequest<{ event: { title: string } }>(
            "GET",
            `/events/${eventTicker}`
          );
          eventCache[eventTicker] = event.event.title;
        }

        eventTitle = eventCache[eventTicker];
      } catch (error) {
        logger.warn("Failed to fetch market/event info for order", {
          ticker: o.ticker,
          error: String(error),
        });
        // Continue with default titles if fetch fails
      }

      return {
        orderId: o.id,
        ticker: o.ticker,
        eventTicker: o.eventTicker,
        marketTitle,
        eventTitle,
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
    })
  );

  return ordersWithTitles;
}
