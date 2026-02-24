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
  options?: { normalizedUsdAmount?: number | null }
) {
  if (status !== "confirmed") {
    return;
  }

  const safeAmount = typeof amount === "number" ? amount : 0;
  const update: {
    totalTrades?: { increment: number };
    totalTradeVolume?: { increment: number };
    totalTransfers?: { increment: number };
    totalTransferVolume?: { increment: number };
    totalDeposits?: { increment: number };
    totalDepositVolume?: { increment: number };
    totalDepositVolumeUsd?: { increment: number };
  } = {};

  if (action === "trade") {
    update.totalTrades = { increment: 1 };
    update.totalTradeVolume = { increment: safeAmount };
  } else if (action === "transfer") {
    update.totalTransfers = { increment: 1 };
    update.totalTransferVolume = { increment: safeAmount };
  } else if (action === "deposit") {
    update.totalDeposits = { increment: 1 };
    update.totalDepositVolume = { increment: safeAmount };

    const safeUsdAmount =
      typeof options?.normalizedUsdAmount === "number" && Number.isFinite(options.normalizedUsdAmount)
        ? options.normalizedUsdAmount
        : 0;
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
  totalTransfers?: { increment: number };
  totalTransferVolume?: { increment: number };
  totalDeposits?: { increment: number };
  totalDepositVolume?: { increment: number };
  totalDepositVolumeUsd?: { increment: number };
}) {
  return {
    totalTrades: update.totalTrades?.increment ?? 0,
    totalTradeVolume: update.totalTradeVolume?.increment ?? 0,
    totalTransfers: update.totalTransfers?.increment ?? 0,
    totalTransferVolume: update.totalTransferVolume?.increment ?? 0,
    totalDeposits: update.totalDeposits?.increment ?? 0,
    totalDepositVolume: update.totalDepositVolume?.increment ?? 0,
    totalDepositVolumeUsd: update.totalDepositVolumeUsd?.increment ?? 0,
  };
}
