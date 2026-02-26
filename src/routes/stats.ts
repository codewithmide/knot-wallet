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

    // Calculate total trades as sum of ALL transaction types:
    // - Swaps (trades)
    // - Transfers (withdrawals)
    // - Deposits
    // - Liquidity operations (add, remove, claim rewards)
    // - Prediction market orders (buy/sell)
    const totalTrades =
      toNumber(statsCache.totalTrades) +           // swaps
      toNumber(statsCache.totalTransfers) +        // transfers/withdrawals
      toNumber(statsCache.totalDeposits) +         // deposits
      toNumber(statsCache.totalLiquidityAdds) +    // LP adds
      toNumber(statsCache.totalLiquidityRemoves) + // LP removes
      toNumber(statsCache.totalRewardsClaimed) +   // LP reward claims
      toNumber(statsCache.totalPredictionOrders);  // prediction buy/sell

    return success(c, "Stats retrieved successfully.", {
      totalAgents: toNumber(statsCache.totalAgents),
      totalTrades,
    });
  } catch (err) {
    return error(c, "Unable to retrieve stats.", 500, { error: String(err) });
  }
});

export { stats };
