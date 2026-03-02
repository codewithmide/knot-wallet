import {
  kalshiRequest,
  KalshiOrder,
  KalshiFill,
  BalanceResponse,
  PositionsResponse,
  OrdersResponse,
  FillsResponse,
  CreateOrderRequest,
  CreateOrderResponse,
} from "../kalshi/client.js";
import { logger } from "../utils/logger.js";
import { createAuditLog } from "../utils/audit.js";
import { checkPolicy } from "../policy/engine.js";

// ============================================================================
// Types
// ============================================================================

export interface BalanceInfo {
  balance: number; // in dollars
  portfolioValue: number; // in dollars
}

export interface PositionInfo {
  ticker: string;
  position: number; // positive = yes contracts, negative = no contracts
  marketExposure: number; // in dollars
  realizedPnl: number; // in dollars
  restingOrdersCount: number;
}

export interface OrderInfo {
  orderId: string;
  ticker: string;
  status: string;
  side: "yes" | "no";
  action: "buy" | "sell";
  type: string;
  price: number; // in cents
  count: number;
  remainingCount: number;
  createdTime: string;
}

export interface PlaceOrderResult {
  orderId: string;
  ticker: string;
  side: "yes" | "no";
  action: "buy" | "sell";
  type: string;
  price: number;
  count: number;
  status: string;
}

// ============================================================================
// Categories & Tags
// ============================================================================

/**
 * Get all available categories and their tags.
 * Returns raw Kalshi tags by categories data.
 */
export async function getCategories(): Promise<Record<string, string[] | null>> {
  logger.info("Fetching Kalshi categories");

  const response = await kalshiRequest<{ tags_by_categories: Record<string, string[] | null> }>(
    "GET",
    "/search/tags_by_categories"
  );

  return response.tags_by_categories;
}

/**
 * Get sports filters with competitions and scopes.
 * Returns raw Kalshi sports filter data.
 */
export async function getSportsFilters(): Promise<Record<string, unknown>> {
  logger.info("Fetching Kalshi sports filters");

  const response = await kalshiRequest<Record<string, unknown>>(
    "GET",
    "/search/filters_by_sport"
  );

  return response;
}

// ============================================================================
// Market Discovery
// ============================================================================

/**
 * List available prediction markets.
 * Returns raw Kalshi market data.
 * @param status Filter by market status: "open", "closed", "settled"
 * @param eventTicker Filter by event ticker
 * @param limit Maximum number of markets to return
 */
export async function listMarkets(options?: {
  status?: "unopened" | "open" | "closed" | "settled";
  eventTicker?: string;
  seriesTicker?: string;
  limit?: number;
  cursor?: string;
}): Promise<{ markets: Record<string, unknown>[]; cursor?: string }> {
  const { status, eventTicker, seriesTicker, limit = 50, cursor } = options || {};

  logger.info("Fetching Kalshi markets", { status, eventTicker, limit });

  const params = new URLSearchParams();
  if (status) params.append("status", status);
  if (eventTicker) params.append("event_ticker", eventTicker);
  if (seriesTicker) params.append("series_ticker", seriesTicker);
  if (limit) params.append("limit", limit.toString());
  if (cursor) params.append("cursor", cursor);

  const queryString = params.toString();
  const path = `/markets${queryString ? `?${queryString}` : ""}`;

  const response = await kalshiRequest<{ markets: Record<string, unknown>[]; cursor?: string }>("GET", path);

  return { markets: response.markets, cursor: response.cursor };
}

/**
 * Get details for a specific market by ticker.
 * Returns the raw Kalshi market data.
 */
export async function getMarket(ticker: string): Promise<Record<string, unknown>> {
  logger.info("Fetching Kalshi market", { ticker });

  const response = await kalshiRequest<{ market: Record<string, unknown> }>(
    "GET",
    `/markets/${ticker}`
  );

  return response.market;
}

/**
 * List events (groups of related markets).
 * Returns raw Kalshi event data.
 * @param category Filter by category (e.g., "Sports", "Crypto", "Politics")
 */
export async function listEvents(options?: {
  status?: "open" | "closed" | "settled";
  seriesTicker?: string;
  withNestedMarkets?: boolean;
  limit?: number;
  cursor?: string;
}): Promise<{ events: Record<string, unknown>[]; cursor?: string }> {
  const { status, seriesTicker, withNestedMarkets, limit = 20, cursor } = options || {};

  logger.info("Fetching Kalshi events", { status, seriesTicker, withNestedMarkets, limit });

  const params = new URLSearchParams();
  if (status) params.append("status", status);
  if (seriesTicker) params.append("series_ticker", seriesTicker);
  if (withNestedMarkets !== undefined) params.append("with_nested_markets", withNestedMarkets.toString());
  if (limit) params.append("limit", limit.toString());
  if (cursor) params.append("cursor", cursor);

  const queryString = params.toString();
  const path = `/events${queryString ? `?${queryString}` : ""}`;

  const response = await kalshiRequest<{ events: Record<string, unknown>[]; cursor?: string }>("GET", path);

  return { events: response.events, cursor: response.cursor };
}

/**
 * Get a specific event by ticker.
 * Returns raw Kalshi event data.
 */
export async function getEvent(eventTicker: string): Promise<Record<string, unknown>> {
  logger.info("Fetching Kalshi event", { eventTicker });

  const response = await kalshiRequest<{ event: Record<string, unknown>; markets: Record<string, unknown>[] }>(
    "GET",
    `/events/${eventTicker}`
  );

  return { ...response.event, markets: response.markets };
}

/**
 * List all series.
 * Returns raw Kalshi series data.
 */
export async function listSeries(options?: {
  category?: string;
  tags?: string;
  includeProductMetadata?: boolean;
  includeVolume?: boolean;
  minUpdatedTs?: number;
  limit?: number;
  cursor?: string;
}): Promise<{ series: Record<string, unknown>[]; cursor?: string }> {
  const { category, tags, includeProductMetadata, includeVolume, minUpdatedTs, limit = 100, cursor } = options || {};

  logger.info("Fetching Kalshi series", { category, tags, includeProductMetadata, includeVolume, minUpdatedTs, limit });

  const params = new URLSearchParams();
  if (category) params.append("category", category);
  if (tags) params.append("tags", tags);
  if (includeProductMetadata !== undefined) params.append("include_product_metadata", includeProductMetadata.toString());
  if (includeVolume !== undefined) params.append("include_volume", includeVolume.toString());
  if (minUpdatedTs !== undefined) params.append("min_updated_ts", minUpdatedTs.toString());
  if (limit) params.append("limit", limit.toString());
  if (cursor) params.append("cursor", cursor);

  const queryString = params.toString();
  const path = `/series${queryString ? `?${queryString}` : ""}`;

  const response = await kalshiRequest<{ series: Record<string, unknown>[]; cursor?: string }>("GET", path);

  return { series: response.series, cursor: response.cursor };
}

/**
 * Get a specific series by ticker.
 * Returns raw Kalshi series data.
 */
export async function getSeries(seriesTicker: string): Promise<Record<string, unknown>> {
  logger.info("Fetching Kalshi series", { seriesTicker });

  const response = await kalshiRequest<{ series: Record<string, unknown> }>(
    "GET",
    `/series/${seriesTicker}`
  );

  return response.series;
}

// ============================================================================
// Milestones & Structured Targets
// ============================================================================

/**
 * List milestones (upcoming games, matches, events).
 * Returns raw Kalshi milestone data.
 * Supports filtering by category (top-level e.g., "Sports", "Crypto") and competition (e.g., "Champions League").
 */
export async function listMilestones(options?: {
  limit?: number;
  minimumStartDate?: string;
  category?: string;
  competition?: string;
  type?: string;
  relatedEventTicker?: string;
  cursor?: string;
  minUpdatedTs?: number;
}): Promise<{ milestones: Record<string, unknown>[]; cursor?: string }> {
  const { limit = 100, minimumStartDate, category, competition, type, relatedEventTicker, cursor, minUpdatedTs } = options || {};

  logger.info("Fetching Kalshi milestones", { category, competition, type, limit });

  const params = new URLSearchParams();
  if (limit) params.append("limit", limit.toString());
  if (minimumStartDate) params.append("minimum_start_date", minimumStartDate);
  if (category) params.append("category", category);
  if (competition) params.append("competition", competition);
  if (type) params.append("type", type);
  if (relatedEventTicker) params.append("related_event_ticker", relatedEventTicker);
  if (cursor) params.append("cursor", cursor);
  if (minUpdatedTs !== undefined) params.append("min_updated_ts", minUpdatedTs.toString());

  const queryString = params.toString();
  const path = `/milestones${queryString ? `?${queryString}` : ""}`;

  const response = await kalshiRequest<{ milestones: Record<string, unknown>[]; cursor?: string }>("GET", path);

  return { milestones: response.milestones, cursor: response.cursor };
}

/**
 * Get a specific milestone by ID.
 * Returns raw Kalshi milestone data.
 */
export async function getMilestone(milestoneId: string): Promise<Record<string, unknown>> {
  logger.info("Fetching Kalshi milestone", { milestoneId });

  const response = await kalshiRequest<{ milestone: Record<string, unknown> }>(
    "GET",
    `/milestones/${milestoneId}`
  );

  return response.milestone;
}

/**
 * List structured targets.
 * Returns raw Kalshi structured target data.
 * Supports filtering by competition (e.g., "Champions League") and type.
 */
export async function listStructuredTargets(options?: {
  type?: string;
  competition?: string;
  pageSize?: number;
  cursor?: string;
}): Promise<{ structuredTargets: Record<string, unknown>[]; cursor?: string }> {
  const { type, competition, pageSize = 100, cursor } = options || {};

  logger.info("Fetching Kalshi structured targets", { type, competition, pageSize });

  const params = new URLSearchParams();
  if (type) params.append("type", type);
  if (competition) params.append("competition", competition);
  if (pageSize) params.append("page_size", pageSize.toString());
  if (cursor) params.append("cursor", cursor);

  const queryString = params.toString();
  const path = `/structured_targets${queryString ? `?${queryString}` : ""}`;

  const response = await kalshiRequest<{ structured_targets: Record<string, unknown>[]; cursor?: string }>("GET", path);

  return { structuredTargets: response.structured_targets, cursor: response.cursor };
}

/**
 * Get a specific structured target by ID.
 * Returns raw Kalshi structured target data.
 */
export async function getStructuredTarget(structuredTargetId: string): Promise<Record<string, unknown>> {
  logger.info("Fetching Kalshi structured target", { structuredTargetId });

  const response = await kalshiRequest<{ structured_target: Record<string, unknown> }>(
    "GET",
    `/structured_targets/${structuredTargetId}`
  );

  return response.structured_target;
}

// ============================================================================
// Portfolio & Account
// ============================================================================

/**
 * Get account balance and portfolio value.
 */
export async function getBalance(): Promise<BalanceInfo> {
  logger.info("Fetching Kalshi balance");

  const response = await kalshiRequest<BalanceResponse>(
    "GET",
    "/portfolio/balance"
  );

  return {
    balance: response.balance / 100, // Convert cents to dollars
    portfolioValue: response.portfolio_value / 100,
  };
}

/**
 * Get current positions in markets.
 */
export async function getPositions(options?: {
  ticker?: string;
  eventTicker?: string;
  limit?: number;
  cursor?: string;
}): Promise<{ positions: PositionInfo[]; cursor?: string }> {
  const { ticker, eventTicker, limit = 50, cursor } = options || {};

  logger.info("Fetching Kalshi positions", { ticker, eventTicker });

  const params = new URLSearchParams();
  if (ticker) params.append("ticker", ticker);
  if (eventTicker) params.append("event_ticker", eventTicker);
  if (limit) params.append("limit", limit.toString());
  if (cursor) params.append("cursor", cursor);

  const queryString = params.toString();
  const path = `/portfolio/positions${queryString ? `?${queryString}` : ""}`;

  const response = await kalshiRequest<PositionsResponse>("GET", path);

  const positions = response.market_positions.map((pos) => ({
    ticker: pos.ticker,
    position: pos.position,
    marketExposure: pos.market_exposure / 100, // Convert cents to dollars
    realizedPnl: pos.realized_pnl / 100,
    restingOrdersCount: pos.resting_orders_count,
  }));

  return { positions, cursor: response.cursor };
}

/**
 * Get order history.
 */
export async function getOrders(options?: {
  ticker?: string;
  status?: "resting" | "canceled" | "executed";
  limit?: number;
  cursor?: string;
}): Promise<{ orders: OrderInfo[]; cursor?: string }> {
  const { ticker, status, limit = 50, cursor } = options || {};

  logger.info("Fetching Kalshi orders", { ticker, status });

  const params = new URLSearchParams();
  if (ticker) params.append("ticker", ticker);
  if (status) params.append("status", status);
  if (limit) params.append("limit", limit.toString());
  if (cursor) params.append("cursor", cursor);

  const queryString = params.toString();
  const path = `/portfolio/orders${queryString ? `?${queryString}` : ""}`;

  const response = await kalshiRequest<OrdersResponse>("GET", path);

  const orders = response.orders.map(formatOrder);

  return { orders, cursor: response.cursor };
}

/**
 * Get trade fills (executed trades).
 */
export async function getFills(options?: {
  ticker?: string;
  limit?: number;
  cursor?: string;
}): Promise<{ fills: KalshiFill[]; cursor?: string }> {
  const { ticker, limit = 50, cursor } = options || {};

  logger.info("Fetching Kalshi fills", { ticker });

  const params = new URLSearchParams();
  if (ticker) params.append("ticker", ticker);
  if (limit) params.append("limit", limit.toString());
  if (cursor) params.append("cursor", cursor);

  const queryString = params.toString();
  const path = `/portfolio/fills${queryString ? `?${queryString}` : ""}`;

  const response = await kalshiRequest<FillsResponse>("GET", path);

  return { fills: response.fills, cursor: response.cursor };
}

// ============================================================================
// Order Management
// ============================================================================

/**
 * Place an order to buy or sell prediction contracts.
 *
 * @param ticker Market ticker (e.g., "KXBTC-24DEC31-T100000")
 * @param side "yes" or "no" - which outcome to trade
 * @param action "buy" or "sell"
 * @param count Number of contracts
 * @param price Price in cents (1-99) for limit orders
 * @param type "limit" or "market"
 */
export async function placeOrder(
  agentId: string,
  ticker: string,
  side: "yes" | "no",
  action: "buy" | "sell",
  count: number,
  price?: number,
  type: "limit" | "market" = "limit"
): Promise<PlaceOrderResult> {
  logger.info("Placing Kalshi order", { ticker, side, action, count, price, type });

  // Policy check
  await checkPolicy(agentId, {
    type: "prediction_market",
    action: "place_order",
    ticker,
    side,
    orderAction: action,
    count,
    price,
  });

  // Validate inputs
  if (type === "limit" && (price === undefined || price < 1 || price > 99)) {
    throw new Error("Limit orders require a price between 1 and 99 cents");
  }

  if (count < 1) {
    throw new Error("Count must be at least 1");
  }

  const orderRequest: CreateOrderRequest = {
    ticker,
    action,
    side,
    type,
    count,
  };

  if (type === "limit" && price !== undefined) {
    orderRequest.yes_price = side === "yes" ? price : 100 - price;
  }

  try {
    const response = await kalshiRequest<CreateOrderResponse>(
      "POST",
      "/portfolio/orders",
      orderRequest
    );

    const order = response.order;

    // Log to audit
    await createAuditLog({
      agentId,
      action: "kalshi_order",
      asset: ticker,
      amount: count,
      to: `${side}:${action}`,
      status: "confirmed",
      metadata: {
        orderId: order.order_id,
        ticker,
        side,
        orderAction: action,
        type,
        price: order.yes_price,
        count,
        status: order.status,
      },
    });

    logger.info("Kalshi order placed", { orderId: order.order_id, status: order.status });

    return {
      orderId: order.order_id,
      ticker: order.ticker,
      side: order.side,
      action: order.action,
      type: order.type,
      price: order.yes_price,
      count: order.count,
      status: order.status,
    };
  } catch (error) {
    await createAuditLog({
      agentId,
      action: "kalshi_order",
      asset: ticker,
      amount: count,
      to: `${side}:${action}`,
      status: "failed",
      metadata: { ticker, side, action, error: String(error) },
    });

    throw error;
  }
}

/**
 * Cancel an existing order.
 */
export async function cancelOrder(
  agentId: string,
  orderId: string
): Promise<{ success: boolean; orderId: string }> {
  logger.info("Canceling Kalshi order", { orderId });

  try {
    await kalshiRequest<{ order: KalshiOrder }>(
      "DELETE",
      `/portfolio/orders/${orderId}`
    );

    await createAuditLog({
      agentId,
      action: "kalshi_cancel",
      to: orderId,
      status: "confirmed",
      metadata: { orderId },
    });

    logger.info("Kalshi order canceled", { orderId });

    return { success: true, orderId };
  } catch (error) {
    await createAuditLog({
      agentId,
      action: "kalshi_cancel",
      to: orderId,
      status: "failed",
      metadata: { orderId, error: String(error) },
    });

    throw error;
  }
}

/**
 * Get a specific order by ID.
 */
export async function getOrder(orderId: string): Promise<OrderInfo> {
  logger.info("Fetching Kalshi order", { orderId });

  const response = await kalshiRequest<{ order: KalshiOrder }>(
    "GET",
    `/portfolio/orders/${orderId}`
  );

  return formatOrder(response.order);
}

// ============================================================================
// Market Data
// ============================================================================

/**
 * Get the orderbook for a market.
 */
export async function getOrderbook(
  ticker: string,
  depth?: number
): Promise<{
  ticker: string;
  yes: { price: number; quantity: number }[];
  no: { price: number; quantity: number }[];
}> {
  logger.info("Fetching Kalshi orderbook", { ticker, depth });

  const params = new URLSearchParams();
  if (depth) params.append("depth", depth.toString());

  const queryString = params.toString();
  const path = `/markets/${ticker}/orderbook${queryString ? `?${queryString}` : ""}`;

  const response = await kalshiRequest<{
    orderbook: {
      ticker: string;
      yes: [number, number][]; // [price, quantity]
      no: [number, number][];
    };
  }>("GET", path);

  return {
    ticker: response.orderbook.ticker,
    yes: response.orderbook.yes.map(([price, quantity]) => ({ price, quantity })),
    no: response.orderbook.no.map(([price, quantity]) => ({ price, quantity })),
  };
}

// ============================================================================
// Helpers
// ============================================================================

function formatOrder(order: KalshiOrder): OrderInfo {
  return {
    orderId: order.order_id,
    ticker: order.ticker,
    status: order.status,
    side: order.side,
    action: order.action,
    type: order.type,
    price: order.yes_price,
    count: order.count,
    remainingCount: order.remaining_count,
    createdTime: order.created_time,
  };
}
