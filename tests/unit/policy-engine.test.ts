import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_POLICY, type AgentPolicy } from "../../src/policy/types.js";

// =============================================================================
// Mock dependencies BEFORE importing the module under test
// =============================================================================

const mockFindUnique = vi.fn();
const mockFindMany = vi.fn();
const mockUpsert = vi.fn();

vi.mock("../../src/db/prisma.js", () => ({
  db: {
    agentPolicy: { findUnique: (...args: unknown[]) => mockFindUnique(...args), upsert: (...args: unknown[]) => mockUpsert(...args) },
    auditLog: { findMany: (...args: unknown[]) => mockFindMany(...args) },
  },
}));

vi.mock("../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Import after mocks
import { checkPolicy, getAgentPolicy, updateAgentPolicy } from "../../src/policy/engine.js";
import { PolicyError } from "../../src/utils/errors.js";

const AGENT_ID = "agent-test-123";

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no custom policy (use defaults)
  mockFindUnique.mockResolvedValue(null);
  // Default: no daily spend
  mockFindMany.mockResolvedValue([]);
});

// =============================================================================
// Default policy values
// =============================================================================

describe("DEFAULT_POLICY", () => {
  it("has sensible defaults", () => {
    expect(DEFAULT_POLICY.maxSingleTransactionInUsd).toBe(100);
    expect(DEFAULT_POLICY.dailyLimitInUsd).toBe(500);
    expect(DEFAULT_POLICY.allowedRecipients).toEqual([]);
    expect(DEFAULT_POLICY.allowTrading).toBe(true);
    expect(DEFAULT_POLICY.allowLiquidityProvision).toBe(true);
    expect(DEFAULT_POLICY.allowPredictionMarkets).toBe(true);
    expect(DEFAULT_POLICY.sessionExpirationHours).toBe(168);
  });
});

// =============================================================================
// Feature enable/disable checks
// =============================================================================

describe("checkPolicy — feature toggles", () => {
  it("allows trade when allowTrading is true (default)", async () => {
    await expect(
      checkPolicy(AGENT_ID, { type: "trade", usdValue: 10 })
    ).resolves.toBeUndefined();
  });

  it("rejects trade when allowTrading is false", async () => {
    mockFindUnique.mockResolvedValue({
      rules: { ...DEFAULT_POLICY, allowTrading: false },
    });

    await expect(
      checkPolicy(AGENT_ID, { type: "trade", usdValue: 10 })
    ).rejects.toThrow(PolicyError);

    await expect(
      checkPolicy(AGENT_ID, { type: "trade", usdValue: 10 })
    ).rejects.toThrow("Trading is not enabled");
  });

  it("rejects LP when allowLiquidityProvision is false", async () => {
    mockFindUnique.mockResolvedValue({
      rules: { ...DEFAULT_POLICY, allowLiquidityProvision: false },
    });

    await expect(
      checkPolicy(AGENT_ID, { type: "add_liquidity", usdValue: 10 })
    ).rejects.toThrow("Liquidity provision is not enabled");
  });

  it("rejects prediction market when disabled", async () => {
    mockFindUnique.mockResolvedValue({
      rules: { ...DEFAULT_POLICY, allowPredictionMarkets: false },
    });

    await expect(
      checkPolicy(AGENT_ID, { type: "prediction_market", usdValue: 10 })
    ).rejects.toThrow("Prediction market trading is not enabled");
  });
});

// =============================================================================
// Recipient whitelist
// =============================================================================

describe("checkPolicy — recipient whitelist", () => {
  it("allows transfer to any address when whitelist is empty", async () => {
    await expect(
      checkPolicy(AGENT_ID, { type: "transfer", usdValue: 5, to: "SoMeRaNdOmAdDrEsS" })
    ).resolves.toBeUndefined();
  });

  it("allows transfer to whitelisted address", async () => {
    mockFindUnique.mockResolvedValue({
      rules: { ...DEFAULT_POLICY, allowedRecipients: ["AllowedAddr1", "AllowedAddr2"] },
    });

    await expect(
      checkPolicy(AGENT_ID, { type: "transfer", usdValue: 5, to: "AllowedAddr1" })
    ).resolves.toBeUndefined();
  });

  it("rejects transfer to non-whitelisted address", async () => {
    mockFindUnique.mockResolvedValue({
      rules: { ...DEFAULT_POLICY, allowedRecipients: ["AllowedAddr1"] },
    });

    await expect(
      checkPolicy(AGENT_ID, { type: "transfer", usdValue: 5, to: "NotInList" })
    ).rejects.toThrow("not in your allowed recipients list");
  });

  it("does not apply whitelist to trades", async () => {
    mockFindUnique.mockResolvedValue({
      rules: { ...DEFAULT_POLICY, allowedRecipients: ["OnlyThisOne"] },
    });

    // Trade type should not trigger whitelist check
    await expect(
      checkPolicy(AGENT_ID, { type: "trade", usdValue: 5 })
    ).resolves.toBeUndefined();
  });
});

// =============================================================================
// Per-transaction USD limit
// =============================================================================

describe("checkPolicy — single transaction limit", () => {
  it("allows transaction within limit", async () => {
    await expect(
      checkPolicy(AGENT_ID, { type: "transfer", usdValue: 99.99 })
    ).resolves.toBeUndefined();
  });

  it("allows transaction exactly at limit", async () => {
    await expect(
      checkPolicy(AGENT_ID, { type: "transfer", usdValue: 100 })
    ).resolves.toBeUndefined();
  });

  it("rejects transaction exceeding limit", async () => {
    await expect(
      checkPolicy(AGENT_ID, { type: "transfer", usdValue: 100.01 })
    ).rejects.toThrow("exceeds single transaction limit");
  });

  it("uses custom per-transaction limit", async () => {
    mockFindUnique.mockResolvedValue({
      rules: { ...DEFAULT_POLICY, maxSingleTransactionInUsd: 50 },
    });

    await expect(
      checkPolicy(AGENT_ID, { type: "trade", usdValue: 51 })
    ).rejects.toThrow("exceeds single transaction limit");

    await expect(
      checkPolicy(AGENT_ID, { type: "trade", usdValue: 50 })
    ).resolves.toBeUndefined();
  });

  it("skips per-transaction limit for remove_liquidity", async () => {
    // Even $10000 withdrawal should pass (remove_liquidity is exempt)
    await expect(
      checkPolicy(AGENT_ID, { type: "remove_liquidity", usdValue: 10_000 })
    ).resolves.toBeUndefined();
  });
});

// =============================================================================
// Daily USD limit
// =============================================================================

describe("checkPolicy — daily limit", () => {
  it("allows when no daily spend", async () => {
    await expect(
      checkPolicy(AGENT_ID, { type: "transfer", usdValue: 50 })
    ).resolves.toBeUndefined();
  });

  it("rejects when daily limit would be exceeded", async () => {
    // Simulate $480 already spent today
    mockFindMany.mockResolvedValue([
      { metadata: { usdValue: 200 } },
      { metadata: { usdValue: 280 } },
    ]);

    await expect(
      checkPolicy(AGENT_ID, { type: "transfer", usdValue: 25 })
    ).rejects.toThrow("exceed daily USD limit");
  });

  it("allows if daily spend + new transaction is within limit", async () => {
    mockFindMany.mockResolvedValue([
      { metadata: { usdValue: 200 } },
    ]);

    await expect(
      checkPolicy(AGENT_ID, { type: "transfer", usdValue: 50 })
    ).resolves.toBeUndefined();
  });

  it("skips daily limit for remove_liquidity", async () => {
    mockFindMany.mockResolvedValue([
      { metadata: { usdValue: 499 } },
    ]);

    // remove_liquidity should be exempt from daily limit
    await expect(
      checkPolicy(AGENT_ID, { type: "remove_liquidity", usdValue: 500 })
    ).resolves.toBeUndefined();
  });
});

// =============================================================================
// getAgentPolicy
// =============================================================================

describe("getAgentPolicy", () => {
  it("returns default policy when no custom policy exists", async () => {
    mockFindUnique.mockResolvedValue(null);
    const policy = await getAgentPolicy(AGENT_ID);
    expect(policy).toEqual(DEFAULT_POLICY);
  });

  it("returns custom policy when set", async () => {
    const custom: AgentPolicy = { ...DEFAULT_POLICY, maxSingleTransactionInUsd: 1000 };
    mockFindUnique.mockResolvedValue({ rules: custom });
    const policy = await getAgentPolicy(AGENT_ID);
    expect(policy.maxSingleTransactionInUsd).toBe(1000);
  });
});

// =============================================================================
// updateAgentPolicy
// =============================================================================

describe("updateAgentPolicy", () => {
  it("merges updates with current defaults", async () => {
    mockFindUnique.mockResolvedValue(null); // no existing policy
    mockUpsert.mockResolvedValue({});

    const updated = await updateAgentPolicy(AGENT_ID, { maxSingleTransactionInUsd: 250 });

    expect(updated.maxSingleTransactionInUsd).toBe(250);
    expect(updated.dailyLimitInUsd).toBe(DEFAULT_POLICY.dailyLimitInUsd); // unchanged
    expect(mockUpsert).toHaveBeenCalledOnce();
  });

  it("merges updates with existing custom policy", async () => {
    mockFindUnique.mockResolvedValue({
      rules: { ...DEFAULT_POLICY, allowTrading: false },
    });
    mockUpsert.mockResolvedValue({});

    const updated = await updateAgentPolicy(AGENT_ID, { dailyLimitInUsd: 1000 });

    expect(updated.allowTrading).toBe(false); // preserved
    expect(updated.dailyLimitInUsd).toBe(1000); // updated
  });
});
