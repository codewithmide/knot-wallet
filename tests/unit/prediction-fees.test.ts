import { describe, it, expect } from "vitest";
import {
  FEE_PERCENTAGE,
  FLAT_FEE_CENTS,
  DEPOSIT_EXPIRATION_MINUTES,
  USDC_MINT,
} from "../../src/services/predictions/types.js";

// =============================================================================
// Fee constants
// =============================================================================

describe("Prediction fee constants", () => {
  it("FEE_PERCENTAGE is 1%", () => {
    expect(FEE_PERCENTAGE).toBe(0.01);
  });

  it("FLAT_FEE_CENTS is $0.10 (10 cents)", () => {
    expect(FLAT_FEE_CENTS).toBe(10);
  });

  it("DEPOSIT_EXPIRATION_MINUTES is 30", () => {
    expect(DEPOSIT_EXPIRATION_MINUTES).toBe(30);
  });

  it("USDC_MINT is the canonical mainnet address", () => {
    expect(USDC_MINT.toBase58()).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  });
});

// =============================================================================
// Fee calculation logic (mirrors trading.ts)
// =============================================================================

/**
 * Replicate the fee logic from src/services/predictions/trading.ts
 * to verify it produces expected results.
 *
 *   baseCost = pricePerContract * count  (cents)
 *   percentageFee = Math.ceil(baseCost * FEE_PERCENTAGE)
 *   feeCents = percentageFee + FLAT_FEE_CENTS
 *   totalCost = baseCost + feeCents   (cents)
 *   totalCostUSDC = totalCost / 100   (dollars)
 */
function calculateFees(pricePerContract: number, count: number) {
  const baseCost = pricePerContract * count;
  const percentageFee = Math.ceil(baseCost * FEE_PERCENTAGE);
  const feeCents = percentageFee + FLAT_FEE_CENTS;
  const totalCost = baseCost + feeCents;
  const totalCostUSDC = totalCost / 100;
  return { baseCost, percentageFee, feeCents, totalCost, totalCostUSDC };
}

describe("Fee calculation", () => {
  it("small order: 1 contract at 50¢", () => {
    const result = calculateFees(50, 1);
    expect(result.baseCost).toBe(50);
    // 1% of 50 = 0.5 → ceil → 1
    expect(result.percentageFee).toBe(1);
    // 1 + 10 flat = 11
    expect(result.feeCents).toBe(11);
    // 50 + 11 = 61
    expect(result.totalCost).toBe(61);
    expect(result.totalCostUSDC).toBe(0.61);
  });

  it("medium order: 10 contracts at 65¢", () => {
    const result = calculateFees(65, 10);
    expect(result.baseCost).toBe(650);
    // 1% of 650 = 6.5 → ceil → 7
    expect(result.percentageFee).toBe(7);
    expect(result.feeCents).toBe(17);
    expect(result.totalCost).toBe(667);
    expect(result.totalCostUSDC).toBeCloseTo(6.67, 2);
  });

  it("large order: 100 contracts at 80¢", () => {
    const result = calculateFees(80, 100);
    expect(result.baseCost).toBe(8000);
    // 1% of 8000 = 80 (exact, no ceil needed)
    expect(result.percentageFee).toBe(80);
    expect(result.feeCents).toBe(90);
    expect(result.totalCost).toBe(8090);
    expect(result.totalCostUSDC).toBe(80.90);
  });

  it("minimum: 1 contract at 1¢", () => {
    const result = calculateFees(1, 1);
    expect(result.baseCost).toBe(1);
    // 1% of 1 = 0.01 → ceil → 1
    expect(result.percentageFee).toBe(1);
    expect(result.feeCents).toBe(11);
    expect(result.totalCost).toBe(12);
    expect(result.totalCostUSDC).toBe(0.12);
  });

  it("99¢ contract (max price): 1 contract", () => {
    const result = calculateFees(99, 1);
    expect(result.baseCost).toBe(99);
    // 1% of 99 = 0.99 → ceil → 1
    expect(result.percentageFee).toBe(1);
    expect(result.feeCents).toBe(11);
    expect(result.totalCost).toBe(110);
    expect(result.totalCostUSDC).toBe(1.10);
  });

  it("flat fee dominates for very small orders", () => {
    const result = calculateFees(2, 1);
    // baseCost=2, percentageFee=ceil(0.02)=1, flat=10 → total fee=11
    // Fee (11) is 5.5x the base cost (2)
    expect(result.feeCents).toBeGreaterThan(result.baseCost);
  });
});
