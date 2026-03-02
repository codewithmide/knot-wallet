import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { idempotency, clearIdempotencyStore } from "../../src/utils/idempotency.js";

vi.mock("../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  clearIdempotencyStore();
});

type Env = { Variables: { agent: { id: string } } };

// Helper: create a minimal Hono app with idempotency middleware
function createTestApp() {
  const app = new Hono<Env>();

  // Simulate auth by attaching an agent to context
  app.use("*", async (c, next) => {
    c.set("agent", { id: "agent-1" });
    await next();
  });

  app.use("*", idempotency);

  let callCount = 0;
  app.post("/action", (c) => {
    callCount++;
    return c.json({ ok: true, call: callCount }, 200);
  });

  app.post("/fail", (c) => {
    callCount++;
    return c.json({ error: "boom" }, 500);
  });

  return { app, getCallCount: () => callCount, resetCallCount: () => { callCount = 0; } };
}

// =============================================================================
// No key — passthrough
// =============================================================================

describe("idempotency — no key", () => {
  it("proceeds normally when no Idempotency-Key header is present", async () => {
    const { app } = createTestApp();
    const res = await app.request("/action", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // No idempotency header in response
    expect(res.headers.get("idempotency-status")).toBeNull();
  });
});

// =============================================================================
// Key too long
// =============================================================================

describe("idempotency — key validation", () => {
  it("rejects keys longer than 128 characters", async () => {
    const { app } = createTestApp();
    const longKey = "x".repeat(129);
    const res = await app.request("/action", {
      method: "POST",
      headers: { "Idempotency-Key": longKey },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.data.code).toBe("INVALID_IDEMPOTENCY_KEY");
  });

  it("accepts keys up to 128 characters", async () => {
    const { app } = createTestApp();
    const key = "k".repeat(128);
    const res = await app.request("/action", {
      method: "POST",
      headers: { "Idempotency-Key": key },
    });
    expect(res.status).toBe(200);
  });
});

// =============================================================================
// Cache hit — replay
// =============================================================================

describe("idempotency — caching", () => {
  it("returns cached response on second request with same key", async () => {
    const { app, getCallCount } = createTestApp();
    const key = "unique-key-1";

    const res1 = await app.request("/action", {
      method: "POST",
      headers: { "Idempotency-Key": key },
    });
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.call).toBe(1);
    expect(res1.headers.get("idempotency-status")).toBe("fresh");

    // Second request with same key — handler should NOT run again
    const res2 = await app.request("/action", {
      method: "POST",
      headers: { "Idempotency-Key": key },
    });
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.call).toBe(1); // Same response as first
    expect(res2.headers.get("idempotency-status")).toBe("cached");

    // Handler was only called once
    expect(getCallCount()).toBe(1);
  });

  it("does not cache non-2xx responses", async () => {
    const { app, getCallCount } = createTestApp();
    const key = "fail-key";

    const res1 = await app.request("/fail", {
      method: "POST",
      headers: { "Idempotency-Key": key },
    });
    expect(res1.status).toBe(500);

    // Second request — handler runs again (not cached)
    const res2 = await app.request("/fail", {
      method: "POST",
      headers: { "Idempotency-Key": key },
    });
    expect(res2.status).toBe(500);

    // Handler called twice
    expect(getCallCount()).toBe(2);
  });

  it("different keys execute separately", async () => {
    const { app, getCallCount } = createTestApp();

    await app.request("/action", {
      method: "POST",
      headers: { "Idempotency-Key": "key-a" },
    });
    await app.request("/action", {
      method: "POST",
      headers: { "Idempotency-Key": "key-b" },
    });

    expect(getCallCount()).toBe(2);
  });
});

// =============================================================================
// Agent scoping
// =============================================================================

describe("idempotency — agent scoping", () => {
  it("same key for different agents are independent", async () => {
    const app = new Hono<Env>();
    let callCount = 0;

    // Dynamic agent ID based on a custom header for test
    app.use("*", async (c, next) => {
      c.set("agent", { id: c.req.header("x-test-agent") ?? "anon" });
      await next();
    });
    app.use("*", idempotency);
    app.post("/act", (c) => {
      callCount++;
      return c.json({ agent: c.get("agent").id, call: callCount }, 200);
    });

    await app.request("/act", {
      method: "POST",
      headers: { "Idempotency-Key": "shared-key", "x-test-agent": "agent-A" },
    });

    await app.request("/act", {
      method: "POST",
      headers: { "Idempotency-Key": "shared-key", "x-test-agent": "agent-B" },
    });

    // Both executed because different agents
    expect(callCount).toBe(2);
  });
});

// =============================================================================
// clearIdempotencyStore
// =============================================================================

describe("clearIdempotencyStore", () => {
  it("clears all cached entries", async () => {
    const { app, getCallCount } = createTestApp();
    const key = "clear-test";

    await app.request("/action", {
      method: "POST",
      headers: { "Idempotency-Key": key },
    });
    expect(getCallCount()).toBe(1);

    clearIdempotencyStore();

    // After clear, same key executes again
    await app.request("/action", {
      method: "POST",
      headers: { "Idempotency-Key": key },
    });
    expect(getCallCount()).toBe(2);
  });
});
