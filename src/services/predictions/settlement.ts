import { db } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";
import { createAuditLog } from "../../utils/audit.js";
import {
  kalshiRequest,
  type KalshiMarket,
} from "../../kalshi/client.js";

// =============================================================================
// Settlement
// =============================================================================

/**
 * Check and settle positions for a resolved market.
 * Called when we detect a market has settled on Kalshi.
 */
export async function settleMarket(
  ticker: string,
  result: "yes" | "no"
): Promise<{ settledCount: number; totalPayout: number }> {
  logger.info("Settling market positions", { ticker, result });

  // Find all unsettled positions for this market
  const positions = await db.predictionPosition.findMany({
    where: { ticker, settled: false },
  });

  let settledCount = 0;
  let totalPayout = 0;

  for (const position of positions) {
    const won = position.side === result;
    // If won, each contract pays out 100 cents ($1)
    // If lost, payout is 0
    const payout = won ? position.quantity * 100 : 0;

    // Update position and credit balance if won
    await db.$transaction(async (tx) => {
      // Mark position as settled
      await tx.predictionPosition.update({
        where: { id: position.id },
        data: {
          settled: true,
          settlementResult: won ? "won" : "lost",
          settlementPayout: payout,
          settledAt: new Date(),
        },
      });

      // Credit balance if won
      if (payout > 0) {
        await tx.predictionBalance.update({
          where: { id: position.predictionBalanceId },
          data: { balance: { increment: payout } },
        });
      }
    });

    // Audit log
    await createAuditLog({
      agentId: position.agentId,
      action: "prediction_settlement",
      asset: ticker,
      amount: payout / 100,
      status: "confirmed",
      metadata: {
        positionId: position.id,
        ticker,
        side: position.side,
        quantity: position.quantity,
        result,
        won,
        payout,
      },
    });

    settledCount++;
    totalPayout += payout;
  }

  logger.info("Market settlement completed", {
    ticker,
    result,
    settledCount,
    totalPayout,
  });

  return { settledCount, totalPayout };
}

/**
 * Check for settled markets and process them.
 * Should be called periodically (cron job or similar).
 */
export async function checkAndSettleMarkets(): Promise<void> {
  logger.info("Checking for settled markets");

  // Get all unique tickers with unsettled positions
  const unsettledPositions = await db.predictionPosition.findMany({
    where: { settled: false },
    select: { ticker: true },
    distinct: ["ticker"],
  });

  for (const { ticker } of unsettledPositions) {
    try {
      const market = await kalshiRequest<{ market: KalshiMarket }>(
        "GET",
        `/markets/${ticker}`
      );

      if (market.market.status === "settled" && market.market.result) {
        await settleMarket(ticker, market.market.result as "yes" | "no");
      }
    } catch (error) {
      logger.error("Failed to check market for settlement", { ticker, error });
    }
  }
}
