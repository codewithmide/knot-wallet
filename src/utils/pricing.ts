import { getTokenByMint } from "./tokens.js";
import { logger } from "./logger.js";

const JUPITER_PRICE_API = "https://api.jup.ag/price/v2";

const STABLE_SYMBOLS = new Set(["USDC", "USDT", "PYUSD", "USDG"]);

interface JupiterPriceResponse {
  data?: Record<string, { price?: number | string }>;
}

export async function getTokenPriceUsd(mint: string): Promise<number | null> {
  const localToken = getTokenByMint(mint);
  if (localToken && STABLE_SYMBOLS.has(localToken.symbol.toUpperCase())) {
    return 1;
  }

  try {
    const url = `${JUPITER_PRICE_API}?ids=${encodeURIComponent(mint)}`;
    const response = await fetch(url);

    if (!response.ok) {
      logger.warn("Price API request failed", { mint, status: response.status });
      return null;
    }

    const payload = (await response.json()) as JupiterPriceResponse;
    const rawPrice = payload.data?.[mint]?.price;

    const parsedPrice = typeof rawPrice === "string"
      ? Number(rawPrice)
      : rawPrice;

    if (typeof parsedPrice === "number" && Number.isFinite(parsedPrice) && parsedPrice > 0) {
      return parsedPrice;
    }

    logger.warn("Price API returned invalid price", { mint, rawPrice });
    return null;
  } catch (error) {
    logger.warn("Price API lookup failed", { mint, error: String(error) });
    return null;
  }
}

export function computeUsdValue(amount: number, priceUsd: number | null): number | null {
  if (!Number.isFinite(amount) || amount <= 0 || priceUsd === null) {
    return null;
  }

  return Number((amount * priceUsd).toFixed(8));
}
