import type { Context, Next } from "hono";
import { error } from "./response.js";

/**
 * In-memory sliding window rate limiter.
 *
 * Each key (IP, email, agentId, etc.) maps to a list of timestamps.
 * On each request we prune expired entries, then check if count < limit.
 *
 * Includes an auto-cleanup interval that removes stale keys every 60s
 * to prevent unbounded memory growth.
 */

interface RateLimitEntry {
  timestamps: number[];
}

interface RateLimitStore {
  entries: Map<string, RateLimitEntry>;
  cleanupTimer: ReturnType<typeof setInterval> | null;
}

interface RateLimitConfig {
  /** Max number of requests allowed in the window */
  limit: number;
  /** Window size in milliseconds */
  windowMs: number;
  /** Function to extract the rate-limit key from the request context */
  keyFn: (c: Context) => string | null;
  /** Optional custom message when rate limited */
  message?: string;
}

const stores = new Map<string, RateLimitStore>();

function getStore(name: string): RateLimitStore {
  let store = stores.get(name);
  if (!store) {
    store = {
      entries: new Map(),
      cleanupTimer: setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of store!.entries) {
          // Remove keys with no recent activity
          if (entry.timestamps.length === 0 || entry.timestamps[entry.timestamps.length - 1] < now - 600_000) {
            store!.entries.delete(key);
          }
        }
      }, 60_000),
    };
    // Allow Node to exit even if the interval is still running
    if (store.cleanupTimer && typeof store.cleanupTimer === "object" && "unref" in store.cleanupTimer) {
      store.cleanupTimer.unref();
    }
    stores.set(name, store);
  }
  return store;
}

/**
 * Check (without middleware) whether a key is rate-limited.
 * Returns { allowed: boolean, remaining: number }.
 */
export function checkRateLimit(
  storeName: string,
  key: string,
  limit: number,
  windowMs: number
): { allowed: boolean; remaining: number; retryAfterMs: number } {
  const store = getStore(storeName);
  const now = Date.now();
  const windowStart = now - windowMs;

  let entry = store.entries.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    store.entries.set(key, entry);
  }

  // Prune expired timestamps
  entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

  if (entry.timestamps.length >= limit) {
    const oldestInWindow = entry.timestamps[0];
    const retryAfterMs = oldestInWindow + windowMs - now;
    return { allowed: false, remaining: 0, retryAfterMs: Math.max(retryAfterMs, 0) };
  }

  entry.timestamps.push(now);
  return { allowed: true, remaining: limit - entry.timestamps.length, retryAfterMs: 0 };
}

/**
 * Create a Hono middleware that rate-limits requests.
 *
 * @param name   Unique name for this limiter's store (e.g. "global-ip", "otp-email")
 * @param config Rate limit configuration
 */
export function rateLimit(name: string, config: RateLimitConfig) {
  const { limit, windowMs, keyFn, message } = config;

  return async (c: Context, next: Next) => {
    const key = keyFn(c);
    if (!key) {
      // If we can't extract a key, skip rate limiting
      return next();
    }

    const result = checkRateLimit(name, key, limit, windowMs);

    // Always set rate-limit headers
    c.header("X-RateLimit-Limit", String(limit));
    c.header("X-RateLimit-Remaining", String(result.remaining));

    if (!result.allowed) {
      const retryAfterSec = Math.ceil(result.retryAfterMs / 1000);
      c.header("Retry-After", String(retryAfterSec));
      c.header("X-RateLimit-Reset", String(Math.ceil((Date.now() + result.retryAfterMs) / 1000)));

      return error(
        c,
        message ?? "Too many requests. Please try again later.",
        429,
        { code: "RATE_LIMIT_EXCEEDED", retryAfterSeconds: retryAfterSec }
      );
    }

    return next();
  };
}

// ─── Pre-configured rate limiters ──────────────────────────────

/** Global: 100 requests per IP per minute */
export const globalIpRateLimit = rateLimit("global-ip", {
  limit: 100,
  windowMs: 60_000,
  keyFn: (c) => {
    // Use X-Forwarded-For if behind a proxy, otherwise fall back to remote address
    const forwarded = c.req.header("x-forwarded-for");
    if (forwarded) return forwarded.split(",")[0].trim();
    // Hono's ConnInfo may not always be available; use a fallback
    return c.req.header("x-real-ip") ?? "unknown";
  },
  message: "Global rate limit exceeded. Please slow down.",
});

// ─── Escalating OTP rate limiter ────────────────────────────────
//
// Progressive cooldown for /connect/start:
//   Level 0 → 3 requests / 10 min
//   Level 1 → 3 requests / 1 hour
//   Level 2 → 3 requests / 6 hours
//   Level 3 → 3 requests / 24 hours
//   After the 24h window expires → resets to level 0
//
// Escalation happens when a window is exhausted without a successful
// OTP completion. Call `resetOtpEscalation(email)` on successful auth.

const OTP_ESCALATION_WINDOWS = [
  10 * 60_000,       // Level 0: 10 minutes
  60 * 60_000,       // Level 1: 1 hour
  6 * 60 * 60_000,   // Level 2: 6 hours
  24 * 60 * 60_000,  // Level 3: 24 hours
];
const OTP_ESCALATION_LIMIT = 3;

interface OtpEscalationEntry {
  level: number;
  timestamps: number[];
  /** When the current window's rate limit was first hit (to track window expiry) */
  lockedUntil: number;
}

const otpEscalationStore = new Map<string, OtpEscalationEntry>();

// Clean up stale escalation entries every 60s
const otpEscalationCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of otpEscalationStore) {
    // If the longest possible window (24h) has passed since last activity, drop it
    const maxWindow = OTP_ESCALATION_WINDOWS[OTP_ESCALATION_WINDOWS.length - 1];
    const lastActivity = entry.timestamps.length > 0
      ? entry.timestamps[entry.timestamps.length - 1]
      : 0;
    if (now - lastActivity > maxWindow && now > entry.lockedUntil) {
      otpEscalationStore.delete(key);
    }
  }
}, 60_000);
if (otpEscalationCleanup && typeof otpEscalationCleanup === "object" && "unref" in otpEscalationCleanup) {
  otpEscalationCleanup.unref();
}

function formatDuration(ms: number): string {
  if (ms >= 60 * 60_000) {
    const hours = Math.ceil(ms / (60 * 60_000));
    return `${hours} hour${hours > 1 ? "s" : ""}`;
  }
  const minutes = Math.ceil(ms / 60_000);
  return `${minutes} minute${minutes > 1 ? "s" : ""}`;
}

/**
 * /connect/start: escalating rate limit per email.
 * Must be placed AFTER zValidator so `c.req.valid("json")` is available.
 */
export const otpStartRateLimit = async (c: Context, next: Next) => {
  let email: string | null = null;
  try {
    const body = c.req.valid("json" as never) as { email?: string };
    email = body?.email?.toLowerCase() ?? null;
  } catch {
    // If we can't get the email, skip rate limiting
  }
  if (!email) return next();

  const key = `email:${email}`;
  const now = Date.now();

  let entry = otpEscalationStore.get(key);
  if (!entry) {
    entry = { level: 0, timestamps: [], lockedUntil: 0 };
    otpEscalationStore.set(key, entry);
  }

  const windowMs = OTP_ESCALATION_WINDOWS[entry.level] ?? OTP_ESCALATION_WINDOWS[OTP_ESCALATION_WINDOWS.length - 1];

  // If the current window has fully expired and we're at the max level,
  // reset back to level 0
  if (entry.level >= OTP_ESCALATION_WINDOWS.length - 1 && now > entry.lockedUntil && entry.lockedUntil > 0) {
    entry.level = 0;
    entry.timestamps = [];
    entry.lockedUntil = 0;
  }

  const currentWindowMs = OTP_ESCALATION_WINDOWS[entry.level];

  // Prune timestamps outside the current window
  const windowStart = now - currentWindowMs;
  entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

  // Still locked out?
  if (now < entry.lockedUntil) {
    const retryAfterMs = entry.lockedUntil - now;
    const retryAfterSec = Math.ceil(retryAfterMs / 1000);
    c.header("X-RateLimit-Limit", String(OTP_ESCALATION_LIMIT));
    c.header("X-RateLimit-Remaining", "0");
    c.header("Retry-After", String(retryAfterSec));
    return error(
      c,
      `Too many OTP requests. Please wait ${formatDuration(retryAfterMs)}.`,
      429,
      { code: "RATE_LIMIT_EXCEEDED", retryAfterSeconds: retryAfterSec }
    );
  }

  // Check if limit is reached in current window
  if (entry.timestamps.length >= OTP_ESCALATION_LIMIT) {
    // Escalate to next level
    const nextLevel = Math.min(entry.level + 1, OTP_ESCALATION_WINDOWS.length - 1);
    const nextWindowMs = OTP_ESCALATION_WINDOWS[nextLevel];
    entry.level = nextLevel;
    entry.lockedUntil = now + nextWindowMs;
    entry.timestamps = [];

    const retryAfterSec = Math.ceil(nextWindowMs / 1000);
    c.header("X-RateLimit-Limit", String(OTP_ESCALATION_LIMIT));
    c.header("X-RateLimit-Remaining", "0");
    c.header("Retry-After", String(retryAfterSec));
    return error(
      c,
      `Too many OTP requests. Please wait ${formatDuration(nextWindowMs)}.`,
      429,
      { code: "RATE_LIMIT_EXCEEDED", retryAfterSeconds: retryAfterSec }
    );
  }

  // Allow the request
  entry.timestamps.push(now);
  c.header("X-RateLimit-Limit", String(OTP_ESCALATION_LIMIT));
  c.header("X-RateLimit-Remaining", String(OTP_ESCALATION_LIMIT - entry.timestamps.length));

  return next();
};

/**
 * Call after a successful OTP completion to reset the escalation
 * for this email back to level 0.
 */
export function resetOtpEscalation(email: string): void {
  otpEscalationStore.delete(`email:${email.toLowerCase()}`);
}

/**
 * /connect/complete: 5 attempts per OTP ID per 10 minutes.
 * Must be placed AFTER zValidator so `c.req.valid("json")` is available.
 */
export const otpCompleteRateLimit = rateLimit("otp-complete", {
  limit: 5,
  windowMs: 10 * 60_000,
  keyFn: (c) => {
    try {
      const { otpId } = c.req.valid("json" as never) as { otpId?: string };
      return otpId ?? null;
    } catch {
      return null;
    }
  },
  message: "Too many OTP verification attempts. Please request a new OTP.",
});

/** Agent actions: 30 requests per agent per minute */
export const agentActionRateLimit = rateLimit("agent-action", {
  limit: 30,
  windowMs: 60_000,
  keyFn: (c) => {
    try {
      const agent = c.get("agent") as { id: string } | undefined;
      return agent?.id ?? null;
    } catch {
      return null;
    }
  },
  message: "Too many requests. Please wait before making more wallet operations.",
});

/**
 * Cleanup all rate limit stores. Call during graceful shutdown.
 */
export function clearAllRateLimitStores(): void {
  for (const [, store] of stores) {
    if (store.cleanupTimer) clearInterval(store.cleanupTimer);
    store.entries.clear();
  }
  stores.clear();
  // Also clear escalating OTP store
  if (otpEscalationCleanup) clearInterval(otpEscalationCleanup);
  otpEscalationStore.clear();
}
