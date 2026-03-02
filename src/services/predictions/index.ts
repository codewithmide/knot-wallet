// =============================================================================
// Predictions Service — Barrel Export
// =============================================================================

// Types
export type {
  PredictionBalanceInfo,
  DepositInitiationResult,
  DepositConfirmationResult,
  DepositResult,
  WithdrawResult,
  BuyResult,
  SellResult,
  AgentPosition,
} from "./types.js";
export { FEE_PERCENTAGE, FLAT_FEE_CENTS, USDC_MINT, DEPOSIT_EXPIRATION_MINUTES } from "./types.js";

// Balance management
export { getOrCreatePredictionBalance, getPredictionBalance, isAdminWalletConfigured } from "./balance.js";

// Deposits
export { initiatePredictionDeposit, completePredictionDeposit, depositToPredictions } from "./deposits.js";

// Withdrawals
export { withdrawFromPredictions } from "./withdrawals.js";

// Trading
export { buyPrediction, sellPrediction } from "./trading.js";

// Position tracking
export { getAgentPositions, getAgentOrders } from "./positions.js";

// Settlement
export { settleMarket, checkAndSettleMarkets } from "./settlement.js";
