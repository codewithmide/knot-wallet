import { db } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";
import { config } from "../../config.js";
import type { PredictionBalanceInfo } from "./types.js";

// =============================================================================
// Balance Management
// =============================================================================

/**
 * Get or create prediction balance for an agent.
 */
export async function getOrCreatePredictionBalance(agentId: string) {
  let balance = await db.predictionBalance.findUnique({
    where: { agentId },
  });

  if (!balance) {
    balance = await db.predictionBalance.create({
      data: { agentId, balance: 0 },
    });
    logger.info("Created prediction balance for agent", { agentId });
  }

  return balance;
}

/**
 * Get agent's prediction balance.
 */
export async function getPredictionBalance(
  agentId: string
): Promise<PredictionBalanceInfo> {
  const balance = await getOrCreatePredictionBalance(agentId);

  return {
    balanceCents: balance.balance,
    balanceDollars: balance.balance / 100,
  };
}

/**
 * Check if admin wallet is configured
 */
export function isAdminWalletConfigured(): boolean {
  return !!(config.KNOT_KALSHI_ADMIN_KEY_ID && config.KNOT_KALSHI_ADMIN_WALLET_ADDRESS);
}
