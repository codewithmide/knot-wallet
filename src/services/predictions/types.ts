import { PublicKey } from "@solana/web3.js";

// =============================================================================
// Constants
// =============================================================================

/** Fee: 1% of order value */
export const FEE_PERCENTAGE = 0.01;

/** Flat fee per transaction: $0.10 (for Turnkey costs) */
export const FLAT_FEE_CENTS = 10;

/** USDC mint address (mainnet) */
export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

/** Deposit expiration time (30 minutes) */
export const DEPOSIT_EXPIRATION_MINUTES = 30;

// =============================================================================
// Interfaces
// =============================================================================

export interface PredictionBalanceInfo {
  balanceCents: number;
  balanceDollars: number;
}

export interface DepositInitiationResult {
  depositId: string;
  usdcAmount: number;
  usdCents: number;
  expiresAt: string;
  instructions: string;
}

export interface DepositConfirmationResult {
  depositId: string;
  usdcAmount: number;
  usdCents: number;
  newBalanceDollars: number;
  status: string;
}

export interface DepositResult {
  depositId: string;
  usdcAmount: number;
  usdCents: number;
  status: string;
}

export interface WithdrawResult {
  withdrawalId: string;
  usdCents: number;
  usdcAmount: number;
  status: string;
}

export interface BuyResult {
  orderId: string;
  ticker: string;
  side: "yes" | "no";
  count: number;
  pricePerContract: number;
  totalCost: number;
  feeCents: number;
  newBalance: number;
}

export interface SellResult {
  orderId: string;
  ticker: string;
  side: "yes" | "no";
  count: number;
  pricePerContract: number;
  totalProceeds: number;
  feeCents: number;
  newBalance: number;
}

export interface AgentPosition {
  ticker: string;
  eventTicker: string | null;
  side: "yes" | "no";
  quantity: number;
  averageCost: number;
  totalCost: number;
  currentPrice: number | null;
  currentValue: number | null;
  unrealizedPnl: number | null;
  settled: boolean;
  settlementResult: string | null;
  settlementPayout: number | null;
}
