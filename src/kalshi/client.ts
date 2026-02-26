import crypto from "crypto";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

const KALSHI_BASE_URL = config.KALSHI_API_BASE_URL;

// Extract the API path prefix from the base URL (e.g., "/trade-api/v2")
const API_PATH_PREFIX = new URL(KALSHI_BASE_URL).pathname;

/**
 * Generate RSA-PSS-SHA256 signature for Kalshi API authentication.
 *
 * The signature is created by signing: timestamp + method + full_path
 * The full path includes the API prefix (e.g., /trade-api/v2/portfolio/balance)
 * Query parameters must be stripped from the path before signing.
 */
function generateSignature(
  timestamp: string,
  method: string,
  path: string
): string {
  // Strip query params from path for signature
  const pathWithoutQuery = path.split("?")[0];
  // Include the API prefix in the signed path
  const fullPath = API_PATH_PREFIX + pathWithoutQuery;
  const message = timestamp + method.toUpperCase() + fullPath;

  // Parse the RSA private key (PEM format)
  // Handle both literal \n and escaped \\n from env vars
  let keyPem = config.KALSHI_RSA_PRIVATE_KEY.replace(/\\n/g, "\n");

  // If the key doesn't have PEM headers, it might be base64-encoded
  if (!keyPem.includes("-----BEGIN")) {
    // Assume it's a raw base64 key, wrap it in PKCS#8 PEM format
    const keyBase64 = keyPem.replace(/\s/g, "");
    keyPem = `-----BEGIN PRIVATE KEY-----\n${keyBase64.match(/.{1,64}/g)?.join("\n")}\n-----END PRIVATE KEY-----`;
  }

  // Create a KeyObject from the PEM - this handles both PKCS#1 and PKCS#8
  const privateKey = crypto.createPrivateKey({
    key: keyPem,
    format: "pem",
  });

  // Sign with RSA-PSS-SHA256
  const signature = crypto.sign("sha256", Buffer.from(message), {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });

  return signature.toString("base64");
}

/**
 * Make an authenticated request to the Kalshi API.
 */
export async function kalshiRequest<T>(
  method: "GET" | "POST" | "DELETE" | "PUT",
  path: string,
  body?: object
): Promise<T> {
  if (!config.KALSHI_API_KEY_ID || !config.KALSHI_RSA_PRIVATE_KEY) {
    throw new Error("Kalshi API credentials not configured");
  }

  const timestamp = Date.now().toString();
  const signature = generateSignature(timestamp, method, path);

  const url = `${KALSHI_BASE_URL}${path}`;

  logger.debug("Kalshi API request", { method, path });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "KALSHI-ACCESS-KEY": config.KALSHI_API_KEY_ID,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
    "KALSHI-ACCESS-SIGNATURE": signature,
  };

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error("Kalshi API error", {
      status: response.status,
      statusText: response.statusText,
      error: errorText,
    });
    throw new Error(`Kalshi API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return data as T;
}

// ============================================================================
// Type Definitions
// ============================================================================

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title: string;
  subtitle: string;
  status: "unopened" | "open" | "active" | "closed" | "settled";
  yes_bid: number; // in cents
  yes_ask: number; // in cents
  no_bid: number;
  no_ask: number;
  last_price: number;
  volume: number;
  volume_24h: number;
  liquidity: number; // in cents
  open_interest: number;
  result?: "yes" | "no" | "";
  close_time: string;
  expiration_time: string;
  market_type?: string;
  can_close_early?: boolean;
}

export interface KalshiEvent {
  event_ticker: string;
  title: string;
  subtitle: string;
  category: string;
  mutually_exclusive: boolean;
  markets: KalshiMarket[];
}

export interface KalshiBalance {
  balance: number; // in cents
  portfolio_value: number; // in cents
}

export interface KalshiPosition {
  ticker: string;
  market_exposure: number;
  position: number; // positive = yes, negative = no
  resting_orders_count: number;
  total_traded: number;
  realized_pnl: number;
}

export interface KalshiOrder {
  order_id: string;
  ticker: string;
  user_id: string;
  status: "resting" | "canceled" | "executed" | "pending";
  side: "yes" | "no";
  action: "buy" | "sell";
  type: "limit" | "market";
  yes_price: number; // in cents
  no_price: number;
  count: number;
  remaining_count: number;
  created_time: string;
  expiration_time?: string;
}

export interface KalshiFill {
  trade_id: string;
  ticker: string;
  side: "yes" | "no";
  action: "buy" | "sell";
  count: number;
  yes_price: number;
  no_price: number;
  created_time: string;
  is_taker: boolean;
}

export interface CreateOrderRequest {
  ticker: string;
  action: "buy" | "sell";
  side: "yes" | "no";
  type: "limit" | "market";
  count: number;
  yes_price?: number; // in cents, required for limit orders
  expiration_time?: string; // ISO timestamp
  client_order_id?: string;
}

export interface CreateOrderResponse {
  order: KalshiOrder;
}

// ============================================================================
// API Response Wrappers
// ============================================================================

export interface MarketsResponse {
  markets: KalshiMarket[];
  cursor?: string;
}

export interface EventsResponse {
  events: KalshiEvent[];
  cursor?: string;
}

export interface BalanceResponse {
  balance: number;
  portfolio_value: number;
}

export interface PositionsResponse {
  market_positions: KalshiPosition[];
  cursor?: string;
}

export interface OrdersResponse {
  orders: KalshiOrder[];
  cursor?: string;
}

export interface FillsResponse {
  fills: KalshiFill[];
  cursor?: string;
}
