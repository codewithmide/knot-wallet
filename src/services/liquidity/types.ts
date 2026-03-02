import { config } from "../../config.js";

// =============================================================================
// Constants
// =============================================================================

/** Entry/exit fee: 1% = 100 basis points */
export const FEE_BPS = 100;

/** Flat fee per transaction ($0.10) — covers Turnkey signing costs */
export const FLAT_FEE_USD = 0.10;

/** Minimum position value in USD — reject if total < $1 */
export const MIN_POSITION_VALUE_USD = 1.0;

/** Meteora DLMM API base URL */
export const METEORA_API = "https://dlmm-api.meteora.ag";

// =============================================================================
// Types
// =============================================================================

export interface PoolInfo {
  address: string;
  name: string;
  mintX: string;
  mintY: string;
  symbolX: string;
  symbolY: string;
  binStep: number;
  baseFeePercentage: string;
  liquidity: string;
  feeApr: string;
  apr: string;
  tradeVolume24h: string;
}

export interface AddLiquidityResult {
  positionId: string;
  poolAddress: string;
  positionPubkey: string;
  strategy: string;
  // Gross amounts deposited by agent
  depositedAmountX: number;
  depositedAmountY: number;
  // Entry fees (stay in admin wallet)
  entryFeeX: number;
  entryFeeY: number;
  // Net amounts actually provided as LP
  netAmountX: number;
  netAmountY: number;
  // Fee details
  entryFeeBps: number;
  flatFeeUsd: number;
  totalFeeUsd: number;
  status: string;
}

export interface RemoveLiquidityResult {
  positionId: string;
  poolAddress: string;
  percentageRemoved: number;
  amountXReturned: number;
  amountYReturned: number;
  exitFeeBps: number;
  feeDeductedX: number;
  feeDeductedY: number;
  status: string;
}

export interface ClaimRewardsResult {
  positionId: string;
  feeX: number;
  feeY: number;
  platformFeeX: number;
  platformFeeY: number;
  netFeeX: number;
  netFeeY: number;
  status: string;
}

export interface AgentPosition {
  id: string;
  poolAddress: string;
  poolName: string | null;
  positionPubkey: string;
  strategy: string;
  amountX: number;
  amountY: number;
  symbolX: string | null;
  symbolY: string | null;
  status: string;
  createdAt: string;
}

export interface PositionDetails {
  id: string;
  poolAddress: string;
  poolName: string | null;
  positionPubkey: string;
  strategy: string;
  symbolX: string | null;
  symbolY: string | null;
  status: string;
  createdAt: string;
  // Current on-chain amounts
  currentAmountX: number;
  currentAmountY: number;
  // Pending rewards (fees earned)
  pendingFeeX: number;
  pendingFeeY: number;
  // Whether there are rewards to claim
  hasRewardsToClaim: boolean;
  // Entry amounts (from database)
  entryAmountX: number;
  entryAmountY: number;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Check if Meteora admin wallet is configured.
 */
export function isMeteoraAdminConfigured(): boolean {
  return !!(config.KNOT_METEORA_ADMIN_KEY_ID && config.KNOT_METEORA_ADMIN_WALLET_ADDRESS);
}
