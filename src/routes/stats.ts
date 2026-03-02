import { Hono } from "hono";
import { createDecipheriv } from "crypto";
import { db } from "../db/prisma.js";
import { config } from "../config.js";
import { error, success } from "../utils/response.js";
import { ensureStatsCache } from "../utils/stats-cache.js";

const stats = new Hono();

const STATS_SCOPE = "stats";
const STATS_TOKEN_HEADER = "X-Stats-Token";

interface StatsTokenPayload {
  ts: number;
  scope: string;
}

function toNumber(value: number | null | undefined): number {
  return typeof value === "number" ? value : 0;
}

function decodeStatsSecret(): Buffer {
  const key = Buffer.from(config.STATS_API_SECRET, "base64");
  if (key.length !== 32) {
    throw new Error("STATS_API_SECRET must be a 32-byte base64 string");
  }
  return key;
}

function decryptStatsToken(token: string, key: Buffer): StatsTokenPayload {
  const raw = Buffer.from(token, "base64");
  if (raw.length < 12 + 16) {
    throw new Error("Invalid stats token length");
  }

  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ciphertext = raw.subarray(12, raw.length - 16);

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  const payload = JSON.parse(plaintext.toString("utf-8")) as StatsTokenPayload;
  if (typeof payload.ts !== "number" || typeof payload.scope !== "string") {
    throw new Error("Invalid stats token payload");
  }

  return payload;
}

function verifyStatsAuth(token: string | undefined): string | null {
  if (!token) {
    return "Missing stats token";
  }

  const key = decodeStatsSecret();
  const payload = decryptStatsToken(token, key);

  if (payload.scope !== STATS_SCOPE) {
    return "Invalid stats token scope";
  }

  const ageMs = Math.abs(Date.now() - payload.ts);
  if (ageMs > config.STATS_TOKEN_TTL_SECONDS * 1000) {
    return "Stats token expired";
  }

  return null;
}

stats.get("/", async (c) => {
  try {
    const token = c.req.header(STATS_TOKEN_HEADER);
    const errorMessage = verifyStatsAuth(token);

    if (errorMessage) {
      return error(c, "Unauthorized stats request.", 401, { reason: errorMessage });
    }

    const statsCache = await ensureStatsCache();

    // Calculate total transactions as sum of ALL transaction types:
    // - Swaps (trades)
    // - Transfers (withdrawals)
    // - Deposits
    // - Liquidity operations (add, remove, claim rewards)
    // - Prediction market orders (buy/sell)
    const totalTransactions =
      toNumber(statsCache.totalTrades) +           // swaps
      toNumber(statsCache.totalTransfers) +        // transfers/withdrawals
      toNumber(statsCache.totalDeposits) +         // deposits
      toNumber(statsCache.totalLiquidityAdds) +    // LP adds
      toNumber(statsCache.totalLiquidityRemoves) + // LP removes
      toNumber(statsCache.totalRewardsClaimed) +   // LP reward claims
      toNumber(statsCache.totalPredictionOrders);  // prediction buy/sell

    // Calculate total volume in USD across all transaction types
    const totalVolumeUsd =
      toNumber(statsCache.totalTradeVolumeUsd) +
      toNumber(statsCache.totalTransferVolumeUsd) +
      toNumber(statsCache.totalDepositVolumeUsd) +
      toNumber(statsCache.totalLiquidityVolumeUsd) +
      toNumber(statsCache.totalPredictionVolumeUsd);

    return success(c, "Stats retrieved successfully.", {
      totalAgents: toNumber(statsCache.totalAgents),
      totalTrades: totalTransactions, // Kept for backwards compatibility
      totalTransactions,
      totalVolumeUsd: Number(totalVolumeUsd.toFixed(2)),
      // Breakdown by category
      volume: {
        trades: {
          count: toNumber(statsCache.totalTrades),
          usd: Number(toNumber(statsCache.totalTradeVolumeUsd).toFixed(2)),
        },
        transfers: {
          count: toNumber(statsCache.totalTransfers),
          usd: Number(toNumber(statsCache.totalTransferVolumeUsd).toFixed(2)),
        },
        deposits: {
          count: toNumber(statsCache.totalDeposits),
          usd: Number(toNumber(statsCache.totalDepositVolumeUsd).toFixed(2)),
        },
        liquidity: {
          adds: toNumber(statsCache.totalLiquidityAdds),
          removes: toNumber(statsCache.totalLiquidityRemoves),
          rewardsClaimed: toNumber(statsCache.totalRewardsClaimed),
          usd: Number(toNumber(statsCache.totalLiquidityVolumeUsd).toFixed(2)),
        },
        predictions: {
          orders: toNumber(statsCache.totalPredictionOrders),
          contracts: toNumber(statsCache.totalPredictionVolume),
          usd: Number(toNumber(statsCache.totalPredictionVolumeUsd).toFixed(2)),
        },
      },
    });
  } catch (err) {
    return error(c, "Unable to retrieve stats.", 500, { error: String(err) });
  }
});

export { stats };
