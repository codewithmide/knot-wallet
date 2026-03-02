import { getTokenByMint } from "./tokens.js";
import { logger } from "./logger.js";
import { config } from "../config.js";

const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";

// Native SOL mint address (wSOL)
const NATIVE_SOL_MINT = "So11111111111111111111111111111111111111112";

const STABLE_SYMBOLS = new Set(["USDC", "USDT", "PYUSD", "USDG"]);

// Hardcoded stable mint addresses for direct matching (fallback)
const STABLE_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", // PYUSD
  "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH", // USDG
]);

// v3 returns usdPrice instead of price
interface JupiterPriceResponse {
  data?: Record<string, { usdPrice?: number | string }>;
}

export async function getTokenPriceUsd(mint: string): Promise<number | null> {
  logger.info("Looking up token price", { mint });

  // Direct check for stablecoin mints (most reliable)
  if (STABLE_MINTS.has(mint)) {
    logger.info("Token is stablecoin (direct mint match)", { mint });
    return 1;
  }

  // Check via local token directory
  const localToken = getTokenByMint(mint);
  if (localToken && STABLE_SYMBOLS.has(localToken.symbol.toUpperCase())) {
    logger.info("Token is stablecoin (local directory)", { mint, symbol: localToken.symbol });
    return 1;
  }

  // Special fallback for native SOL using CoinGecko
  if (mint === NATIVE_SOL_MINT) {
    try {
      const response = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
      );
      if (response.ok) {
        const data = await response.json() as { solana?: { usd?: number } };
        const price = data.solana?.usd;
        if (typeof price === "number" && price > 0) {
          logger.info("SOL price fetched from CoinGecko", { price });
          return price;
        }
      }
    } catch (error) {
      logger.warn("CoinGecko price lookup failed for SOL", { error: String(error) });
    }
  }

  try {
    // Jupiter Price API uses "SOL" as the ID for native SOL, not the mint address
    const priceId = mint === NATIVE_SOL_MINT ? "SOL" : mint;
    const url = `${JUPITER_PRICE_API}?ids=${encodeURIComponent(priceId)}`;
    const response = await fetch(url, {
      headers: {
        "x-api-key": config.JUPITER_API_KEY,
      },
    });

    if (!response.ok) {
      logger.warn("Jupiter Price API request failed", { mint, priceId, status: response.status });
      return null;
    }

    const payload = (await response.json()) as JupiterPriceResponse;
    const rawPrice = payload.data?.[priceId]?.usdPrice;

    const parsedPrice = typeof rawPrice === "string"
      ? Number(rawPrice)
      : rawPrice;

    if (typeof parsedPrice === "number" && Number.isFinite(parsedPrice) && parsedPrice > 0) {
      logger.info("Price fetched successfully from Jupiter", { mint, priceId, price: parsedPrice });
      return parsedPrice;
    }

    logger.warn("Jupiter Price API returned invalid price", { mint, priceId, rawPrice });
    return null;
  } catch (error) {
    logger.warn("Jupiter Price API lookup failed", { mint, error: String(error) });
    return null;
  }
}

export function computeUsdValue(amount: number, priceUsd: number | null): number | null {
  if (!Number.isFinite(amount) || amount <= 0 || priceUsd === null) {
    return null;
  }

  return Number((amount * priceUsd).toFixed(8));
}
