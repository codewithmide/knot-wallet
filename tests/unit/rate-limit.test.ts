import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { checkRateLimit, clearAllRateLimitStores } from "../../src/utils/rate-limit.js";

afterEach(() => {
  clearAllRateLimitStores();
});

// =============================================================================
// checkRateLimit — pure function tests
// =============================================================================

describe("checkRateLimit", () => {
  it("allows the first request", () => {
    const result = checkRateLimit("test", "key-1", 5, 60_000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
    expect(result.retryAfterMs).toBe(0);
  });

  it("decrements remaining count on each request", () => {
    const limit = 3;
    const r1 = checkRateLimit("test-dec", "k", limit, 60_000);
    expect(r1.remaining).toBe(2);

    const r2 = checkRateLimit("test-dec", "k", limit, 60_000);
    expect(r2.remaining).toBe(1);

    const r3 = checkRateLimit("test-dec", "k", limit, 60_000);
    expect(r3.remaining).toBe(0);
  });

  it("denies after limit is reached", () => {
    const limit = 2;
    checkRateLimit("test-deny", "k", limit, 60_000);
    checkRateLimit("test-deny", "k", limit, 60_000);

    const r = checkRateLimit("test-deny", "k", limit, 60_000);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
    expect(r.retryAfterMs).toBeGreaterThan(0);
  });

  it("tracks keys independently", () => {
    const limit = 1;
    const r1 = checkRateLimit("test-indep", "a", limit, 60_000);
    expect(r1.allowed).toBe(true);

    const r2 = checkRateLimit("test-indep", "b", limit, 60_000);
    expect(r2.allowed).toBe(true);

    // "a" is now exhausted
    const r3 = checkRateLimit("test-indep", "a", limit, 60_000);
    expect(r3.allowed).toBe(false);

    // "b" is also exhausted
    const r4 = checkRateLimit("test-indep", "b", limit, 60_000);
    expect(r4.allowed).toBe(false);
  });

  it("tracks stores independently", () => {
    const limit = 1;
    const r1 = checkRateLimit("store-A", "k", limit, 60_000);
    expect(r1.allowed).toBe(true);

    // Same key in a different store should still be allowed
    const r2 = checkRateLimit("store-B", "k", limit, 60_000);
    expect(r2.allowed).toBe(true);
  });

  it("allows again after window expires", () => {
    vi.useFakeTimers();
    try {
      const limit = 1;
      const windowMs = 10_000;

      const r1 = checkRateLimit("test-expire", "k", limit, windowMs);
      expect(r1.allowed).toBe(true);

      const r2 = checkRateLimit("test-expire", "k", limit, windowMs);
      expect(r2.allowed).toBe(false);

      // Advance past the window
      vi.advanceTimersByTime(windowMs + 1);

      const r3 = checkRateLimit("test-expire", "k", limit, windowMs);
      expect(r3.allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns correct retryAfterMs when denied", () => {
    vi.useFakeTimers({ now: 1000 });
    try {
      const limit = 1;
      const windowMs = 5000;

      checkRateLimit("test-retry", "k", limit, windowMs);

      // Advance 2 seconds
      vi.advanceTimersByTime(2000);

      const result = checkRateLimit("test-retry", "k", limit, windowMs);
      expect(result.allowed).toBe(false);
      // The oldest timestamp is at 1000, window is 5000ms, current time is 3000
      // retryAfterMs = 1000 + 5000 - 3000 = 3000
      expect(result.retryAfterMs).toBe(3000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prunes expired timestamps within sliding window", () => {
    vi.useFakeTimers();
    try {
      const limit = 2;
      const windowMs = 10_000;

      // Fill up limit
      checkRateLimit("test-prune", "k", limit, windowMs);
      vi.advanceTimersByTime(1000);
      checkRateLimit("test-prune", "k", limit, windowMs);

      // Should be denied
      expect(checkRateLimit("test-prune", "k", limit, windowMs).allowed).toBe(false);

      // Advance so the first timestamp expires (but not the second)
      vi.advanceTimersByTime(9001); // total: 10001ms from first, 9001ms from second

      // First timestamp was pruned — we have room for one more
      const r = checkRateLimit("test-prune", "k", limit, windowMs);
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(0); // 1 old + 1 new = 2 = limit, so 0 remaining
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles high burst then recovery", () => {
    vi.useFakeTimers();
    try {
      const limit = 5;
      const windowMs = 1000;

      // Burst all 5
      for (let i = 0; i < limit; i++) {
        expect(checkRateLimit("burst", "k", limit, windowMs).allowed).toBe(true);
      }

      // 6th denied
      expect(checkRateLimit("burst", "k", limit, windowMs).allowed).toBe(false);

      // Wait full window
      vi.advanceTimersByTime(1001);

      // All 5 available again
      for (let i = 0; i < limit; i++) {
        expect(checkRateLimit("burst", "k", limit, windowMs).allowed).toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

// =============================================================================
// clearAllRateLimitStores
// =============================================================================

describe("clearAllRateLimitStores", () => {
  it("resets all rate limit state", () => {
    const limit = 1;
    checkRateLimit("clear-test", "k", limit, 60_000);
    expect(checkRateLimit("clear-test", "k", limit, 60_000).allowed).toBe(false);

    clearAllRateLimitStores();

    // After clearing, should be allowed again
    expect(checkRateLimit("clear-test", "k", limit, 60_000).allowed).toBe(true);
  });
});
