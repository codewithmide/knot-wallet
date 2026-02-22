import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { success, error } from "../utils/response.js";
import { logger } from "../utils/logger.js";
import { config } from "../config.js";
import { getTokenByMint, TOKEN_DIRECTORY, isMintAddress } from "../utils/tokens.js";

const tokens = new Hono();

const JUPITER_API_BASE = "https://api.jup.ag";

export interface TokenInfoResponse {
  mint: string;
  symbol: string;
  name: string;
  decimals: number | null;
  verified: boolean;
  source: "local" | "jupiter" | "helius";
}

/**
 * GET /tokens/:query
 * Look up token information by mint address OR symbol.
 * Examples: /tokens/USDG, /tokens/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
 */
tokens.get(
  "/:query",
  zValidator("param", z.object({ query: z.string().min(1).max(44) })),
  async (c) => {
    const { query } = c.req.valid("param");

    try {
      // Check if input looks like a mint address or a symbol
      if (isMintAddress(query)) {
        // Input is a mint address - look up by mint
        return await lookupByMint(c, query);
      } else {
        // Input is likely a symbol - look up by symbol
        return await lookupBySymbol(c, query);
      }
    } catch (err) {
      logger.error("Failed to fetch token info", { query, error: String(err) });
      return error(c, "Failed to fetch token info.", 500);
    }
  }
);

/**
 * Look up token by mint address
 */
async function lookupByMint(c: any, mint: string) {
  // 1. Check local directory first
  const localToken = getTokenByMint(mint);
  if (localToken) {
    return success(c, "Token info retrieved.", {
      mint,
      symbol: localToken.symbol,
      name: localToken.name,
      decimals: localToken.decimals,
      verified: localToken.verified,
      source: "local",
    });
  }

  // 2. Try Jupiter API
  const jupiterToken = await fetchJupiterTokenInfo(mint);
  if (jupiterToken) {
    return success(c, "Token info retrieved.", {
      mint,
      symbol: jupiterToken.symbol,
      name: jupiterToken.name,
      decimals: jupiterToken.decimals,
      verified: jupiterToken.verified,
      source: "jupiter",
    });
  }

  // 3. Try Helius DAS API
  const heliusToken = await fetchHeliusTokenInfo(mint);
  if (heliusToken) {
    return success(c, "Token info retrieved.", {
      mint,
      symbol: heliusToken.symbol,
      name: heliusToken.name,
      decimals: heliusToken.decimals,
      verified: false,
      source: "helius",
    });
  }

  // 4. Token not found
  return error(c, "Token not found.", 404, { mint });
}

/**
 * Look up token by symbol (e.g., "USDG", "SOL", "USDC")
 */
async function lookupBySymbol(c: any, symbol: string) {
  const upperSymbol = symbol.toUpperCase();

  // 1. Check local directory first
  const localToken = TOKEN_DIRECTORY[upperSymbol];
  if (localToken) {
    return success(c, "Token info retrieved.", {
      mint: localToken.mint,
      symbol: localToken.symbol,
      name: localToken.name,
      decimals: localToken.decimals,
      verified: localToken.verified,
      source: "local",
    });
  }

  // 2. Search Jupiter API for the symbol
  const jupiterToken = await searchJupiterBySymbol(symbol);
  if (jupiterToken) {
    return success(c, "Token info retrieved.", {
      mint: jupiterToken.mint,
      symbol: jupiterToken.symbol,
      name: jupiterToken.name,
      decimals: jupiterToken.decimals,
      verified: jupiterToken.verified,
      source: "jupiter",
    });
  }

  // 3. Token not found
  return error(c, `Token "${symbol}" not found.`, 404, { symbol });
}

/**
 * Search Jupiter API for token by symbol
 */
async function searchJupiterBySymbol(
  symbol: string
): Promise<{ mint: string; symbol: string; name: string; decimals: number; verified: boolean } | null> {
  try {
    const url = `${JUPITER_API_BASE}/tokens/v2/search?query=${encodeURIComponent(symbol)}`;

    const response = await fetch(url, {
      headers: {
        "x-api-key": config.JUPITER_API_KEY,
      },
    });

    if (!response.ok) {
      return null;
    }

    const tokens = await response.json();

    // Filter for verified tokens and find exact symbol match first
    const verifiedTokens = tokens.filter((t: any) => t.isVerified === true);

    // Prefer exact symbol match
    const exactMatch = verifiedTokens.find(
      (t: any) => t.symbol.toUpperCase() === symbol.toUpperCase()
    );

    const token = exactMatch || verifiedTokens[0];

    if (token) {
      return {
        mint: token.id,
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        verified: true,
      };
    }
  } catch {
    // Silently fail
  }
  return null;
}

/**
 * Fetch token info from Jupiter API by mint address.
 */
async function fetchJupiterTokenInfo(
  mint: string
): Promise<{ symbol: string; name: string; decimals: number; verified: boolean } | null> {
  try {
    const url = `${JUPITER_API_BASE}/tokens/v1/${mint}`;

    const response = await fetch(url, {
      headers: {
        "x-api-key": config.JUPITER_API_KEY,
      },
    });

    if (!response.ok) {
      return null;
    }

    const token = await response.json();

    if (token && token.symbol) {
      return {
        symbol: token.symbol,
        name: token.name || token.symbol,
        decimals: token.decimals,
        verified: token.isVerified ?? false,
      };
    }
  } catch {
    // Silently fail, will try Helius next
  }
  return null;
}

/**
 * Fetch token info from Helius DAS API by mint address.
 */
async function fetchHeliusTokenInfo(
  mint: string
): Promise<{ symbol: string; name: string; decimals: number | null } | null> {
  try {
    const heliusUrl = `https://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`;

    const response = await fetch(heliusUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "knot-token-info",
        method: "getAsset",
        params: {
          id: mint,
        },
      }),
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    if (data.error) {
      return null;
    }

    if (data.result?.content?.metadata) {
      const metadata = data.result.content.metadata;
      return {
        symbol: metadata.symbol || mint.slice(0, 4) + "...",
        name: metadata.name || "Unknown Token",
        decimals: null, // Helius DAS doesn't return decimals in metadata
      };
    }
  } catch {
    // Silently fail
  }
  return null;
}

export { tokens };
