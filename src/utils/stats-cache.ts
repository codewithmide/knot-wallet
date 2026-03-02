import { db } from "../db/prisma.js";

const STATS_CACHE_ID = "global";

export async function ensureStatsCache() {
  return db.statsCache.upsert({
    where: { id: STATS_CACHE_ID },
    create: { id: STATS_CACHE_ID },
    update: {},
  });
}

export async function incrementTotalAgents() {
  return db.statsCache.upsert({
    where: { id: STATS_CACHE_ID },
    create: { id: STATS_CACHE_ID, totalAgents: 1 },
    update: { totalAgents: { increment: 1 } },
  });
}

export async function incrementStatsForAudit(
  action: string,
  status: string,
  amount?: number | null,
  options?: { normalizedUsdAmount?: number | null; count?: number | null }
) {
  if (status !== "confirmed") {
    return;
  }

  const safeAmount = typeof amount === "number" ? amount : 0;
  const safeUsdAmount =
    typeof options?.normalizedUsdAmount === "number" && Number.isFinite(options.normalizedUsdAmount)
      ? options.normalizedUsdAmount
      : 0;

  const update: {
    totalTrades?: { increment: number };
    totalTradeVolume?: { increment: number };
    totalTradeVolumeUsd?: { increment: number };
    totalTransfers?: { increment: number };
    totalTransferVolume?: { increment: number };
    totalTransferVolumeUsd?: { increment: number };
    totalDeposits?: { increment: number };
    totalDepositVolume?: { increment: number };
    totalDepositVolumeUsd?: { increment: number };
    totalLiquidityAdds?: { increment: number };
    totalLiquidityRemoves?: { increment: number };
    totalRewardsClaimed?: { increment: number };
    totalLiquidityVolumeUsd?: { increment: number };
    totalPredictionOrders?: { increment: number };
    totalPredictionVolume?: { increment: number };
    totalPredictionVolumeUsd?: { increment: number };
  } = {};

  if (action === "trade") {
    update.totalTrades = { increment: 1 };
    update.totalTradeVolume = { increment: safeAmount };
    update.totalTradeVolumeUsd = { increment: safeUsdAmount };
  } else if (action === "transfer") {
    update.totalTransfers = { increment: 1 };
    update.totalTransferVolume = { increment: safeAmount };
    update.totalTransferVolumeUsd = { increment: safeUsdAmount };
  } else if (action === "deposit") {
    update.totalDeposits = { increment: 1 };
    update.totalDepositVolume = { increment: safeAmount };
    update.totalDepositVolumeUsd = { increment: safeUsdAmount };
  } else if (action === "add_liquidity") {
    update.totalLiquidityAdds = { increment: 1 };
    update.totalLiquidityVolumeUsd = { increment: safeUsdAmount };
  } else if (action === "remove_liquidity") {
    update.totalLiquidityRemoves = { increment: 1 };
    update.totalLiquidityVolumeUsd = { increment: safeUsdAmount };
  } else if (action === "claim_rewards") {
    update.totalRewardsClaimed = { increment: 1 };
    update.totalLiquidityVolumeUsd = { increment: safeUsdAmount };
  } else if (action === "kalshi_order" || action === "prediction_buy" || action === "prediction_sell") {
    // Track prediction market orders (buy/sell contracts)
    update.totalPredictionOrders = { increment: 1 };
    const safeCount = typeof options?.count === "number" ? options.count : safeAmount; // count is contract count
    update.totalPredictionVolume = { increment: safeCount };
    update.totalPredictionVolumeUsd = { increment: safeUsdAmount };
  } else if (action === "prediction_deposit") {
    // Track prediction market deposits (USDC → Kalshi)
    update.totalDeposits = { increment: 1 };
    update.totalDepositVolume = { increment: safeAmount };
    update.totalDepositVolumeUsd = { increment: safeUsdAmount };
  } else {
    return;
  }

  await db.statsCache.upsert({
    where: { id: STATS_CACHE_ID },
    create: { id: STATS_CACHE_ID, ...materializeCreate(update) },
    update,
  });
}

function materializeCreate(update: {
  totalTrades?: { increment: number };
  totalTradeVolume?: { increment: number };
  totalTradeVolumeUsd?: { increment: number };
  totalTransfers?: { increment: number };
  totalTransferVolume?: { increment: number };
  totalTransferVolumeUsd?: { increment: number };
  totalDeposits?: { increment: number };
  totalDepositVolume?: { increment: number };
  totalDepositVolumeUsd?: { increment: number };
  totalLiquidityAdds?: { increment: number };
  totalLiquidityRemoves?: { increment: number };
  totalRewardsClaimed?: { increment: number };
  totalLiquidityVolumeUsd?: { increment: number };
  totalPredictionOrders?: { increment: number };
  totalPredictionVolume?: { increment: number };
  totalPredictionVolumeUsd?: { increment: number };
}) {
  return {
    totalTrades: update.totalTrades?.increment ?? 0,
    totalTradeVolume: update.totalTradeVolume?.increment ?? 0,
    totalTradeVolumeUsd: update.totalTradeVolumeUsd?.increment ?? 0,
    totalTransfers: update.totalTransfers?.increment ?? 0,
    totalTransferVolume: update.totalTransferVolume?.increment ?? 0,
    totalTransferVolumeUsd: update.totalTransferVolumeUsd?.increment ?? 0,
    totalDeposits: update.totalDeposits?.increment ?? 0,
    totalDepositVolume: update.totalDepositVolume?.increment ?? 0,
    totalDepositVolumeUsd: update.totalDepositVolumeUsd?.increment ?? 0,
    totalLiquidityAdds: update.totalLiquidityAdds?.increment ?? 0,
    totalLiquidityRemoves: update.totalLiquidityRemoves?.increment ?? 0,
    totalRewardsClaimed: update.totalRewardsClaimed?.increment ?? 0,
    totalLiquidityVolumeUsd: update.totalLiquidityVolumeUsd?.increment ?? 0,
    totalPredictionOrders: update.totalPredictionOrders?.increment ?? 0,
    totalPredictionVolume: update.totalPredictionVolume?.increment ?? 0,
    totalPredictionVolumeUsd: update.totalPredictionVolumeUsd?.increment ?? 0,
  };
}
