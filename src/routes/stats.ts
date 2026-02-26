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

    const activeSince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [statsCache, activeAgents] = await Promise.all([
      ensureStatsCache(),
      db.agent.count({ where: { lastActiveAt: { gte: activeSince } } }),
    ]);

    const totals = {
      agents: toNumber(statsCache.totalAgents),
      activeAgents,
      trades: toNumber(statsCache.totalTrades),
      tradeVolume: toNumber(statsCache.totalTradeVolume),
      transfers: toNumber(statsCache.totalTransfers),
      transferVolume: toNumber(statsCache.totalTransferVolume),
      deposits: toNumber(statsCache.totalDeposits),
      depositVolume: toNumber(statsCache.totalDepositVolume),
      depositVolumeUsd: toNumber(statsCache.totalDepositVolumeUsd),
      // Liquidity Provision (Meteora DLMM)
      liquidityAdds: toNumber(statsCache.totalLiquidityAdds),
      liquidityRemoves: toNumber(statsCache.totalLiquidityRemoves),
      rewardsClaimed: toNumber(statsCache.totalRewardsClaimed),
      // Prediction Markets (Kalshi)
      predictionOrders: toNumber(statsCache.totalPredictionOrders),
      predictionVolume: toNumber(statsCache.totalPredictionVolume),
    };

    return success(c, "Stats retrieved successfully.", {
      totals,
      windows: {
        activeAgentsDays: 30,
      },
      updatedAt: statsCache.updatedAt.toISOString(),
    });
  } catch (err) {
    return error(c, "Unable to retrieve stats.", 500, { error: String(err) });
  }
});

export { stats };
