import type { Context, Next } from "hono";
import { error } from "./response.js";
import { logger } from "./logger.js";

/**
 * In-memory request idempotency layer.
 *
 * Clients send an `Idempotency-Key` header (UUID) with mutation requests.
 * - First time: request executes normally, response is cached.
 * - Subsequent times: cached response is returned without re-execution.
 * - Keys expire after TTL (default: 24 hours) to prevent unbounded growth.
 *
 * This prevents duplicate transfers/trades when agents retry on network errors.
 * The key is scoped per-agent (agentId + idempotencyKey) so keys from different
 * agents never collide.
 */

interface CachedResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  createdAt: number;
}

// "processing" sentinel means the request is currently in-flight
type IdempotencyEntry = CachedResponse | "processing";

const store = new Map<string, IdempotencyEntry>();

const DEFAULT_TTL_MS = 24 * 60 * 60_000; // 24 hours

// Cleanup expired entries every 5 minutes
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry === "processing") continue;
    if (now - entry.createdAt > DEFAULT_TTL_MS) {
      store.delete(key);
    }
  }
}, 5 * 60_000);
if (cleanupTimer && typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
  cleanupTimer.unref();
}

/**
 * Hono middleware that enforces request idempotency.
 *
 * Usage: place after `authMiddleware` on mutation routes.
 * Requires the `Idempotency-Key` header on financial mutation endpoints.
 * Returns 400 if the header is missing.
 */
export async function idempotency(c: Context, next: Next) {
  const idempotencyKey = c.req.header("idempotency-key");

  // Require idempotency key on mutation endpoints
  if (!idempotencyKey) {
    return error(
      c,
      "Idempotency-Key header is required for this endpoint. Send a unique value (UUID recommended) to prevent duplicate operations.",
      400,
      { code: "MISSING_IDEMPOTENCY_KEY" }
    );
  }

  // Validate key format (expect UUID-like or reasonable string)
  if (idempotencyKey.length > 128) {
    return error(c, "Idempotency-Key must be at most 128 characters.", 400, {
      code: "INVALID_IDEMPOTENCY_KEY",
    });
  }

  // Scope key per agent to prevent cross-agent collisions
  const agent = c.get("agent") as { id: string } | undefined;
  const scopedKey = agent ? `${agent.id}:${idempotencyKey}` : `anon:${idempotencyKey}`;

  const existing = store.get(scopedKey);

  // Already have a cached successful response → return it
  if (existing && existing !== "processing") {
    logger.debug("Idempotency cache hit", { key: idempotencyKey });
    c.header("Idempotency-Status", "cached");

    // Replay cached headers
    for (const [k, v] of Object.entries(existing.headers)) {
      c.header(k, v);
    }

    return c.json(existing.body as object, existing.status as 200);
  }

  // Request is currently in-flight from another concurrent call
  if (existing === "processing") {
    return error(
      c,
      "A request with this Idempotency-Key is already being processed. Please wait and retry.",
      409,
      { code: "IDEMPOTENCY_CONFLICT" }
    );
  }

  // Mark as processing to prevent concurrent duplicates
  store.set(scopedKey, "processing");

  try {
    // Execute the actual handler
    await next();

    // Cache the response if it was successful (2xx)
    const status = c.res.status;
    if (status >= 200 && status < 300) {
      // Clone the response body for caching
      const clonedRes = c.res.clone();
      const body = await clonedRes.json();

      // Capture relevant response headers
      const headers: Record<string, string> = {};
      const contentType = c.res.headers.get("content-type");
      if (contentType) headers["content-type"] = contentType;

      store.set(scopedKey, {
        status,
        body,
        headers,
        createdAt: Date.now(),
      });

      c.header("Idempotency-Status", "fresh");
    } else {
      // Non-success responses are not cached — allow retry
      store.delete(scopedKey);
    }
  } catch (err) {
    // On error, remove the processing sentinel so the key can be reused
    store.delete(scopedKey);
    throw err;
  }
}

/**
 * Clear the idempotency store. Call during graceful shutdown.
 */
export function clearIdempotencyStore(): void {
  if (cleanupTimer) clearInterval(cleanupTimer);
  store.clear();
}
