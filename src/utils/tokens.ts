import { config } from "../config.js";
import { logger } from "./logger.js";

const JUPITER_API_BASE = "https://api.jup.ag";

/**
 * Local directory of verified popular tokens.
 * Symbol (uppercase) -> Token info
 *
 * This avoids API calls for common tokens.
 * Fallback to Jupiter API for tokens not in this list.
 */
export const TOKEN_DIRECTORY: Record<string, TokenInfo> = {
  // Native
  SOL: {
    mint: "So11111111111111111111111111111111111111112",
    symbol: "SOL",
    name: "Solana",
    decimals: 9,
    verified: true,
  },

  // Stablecoins
  USDC: {
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    verified: true,
  },
  USDT: {
    mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    verified: true,
  },
  PYUSD: {
    mint: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
    symbol: "PYUSD",
    name: "PayPal USD",
    decimals: 6,
    verified: true,
  },
  USDG: {
    mint: "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH",
    symbol: "USDG",
    name: "Global Dollar",
    decimals: 6,
    verified: true,
  },

  // Major tokens
  JUP: {
    mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    symbol: "JUP",
    name: "Jupiter",
    decimals: 6,
    verified: true,
  },
  BONK: {
    mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    symbol: "BONK",
    name: "Bonk",
    decimals: 5,
    verified: true,
  },
  WIF: {
    mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
    symbol: "WIF",
    name: "dogwifhat",
    decimals: 6,
    verified: true,
  },
  POPCAT: {
    mint: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr",
    symbol: "POPCAT",
    name: "Popcat",
    decimals: 9,
    verified: true,
  },
  PYTH: {
    mint: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",
    symbol: "PYTH",
    name: "Pyth Network",
    decimals: 6,
    verified: true,
  },
  JTO: {
    mint: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
    symbol: "JTO",
    name: "Jito",
    decimals: 9,
    verified: true,
  },
  TNSR: {
    mint: "TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6",
    symbol: "TNSR",
    name: "Tensor",
    decimals: 9,
    verified: true,
  },
  W: {
    mint: "85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ",
    symbol: "W",
    name: "Wormhole",
    decimals: 6,
    verified: true,
  },
  RAY: {
    mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
    symbol: "RAY",
    name: "Raydium",
    decimals: 6,
    verified: true,
  },
  ORCA: {
    mint: "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE",
    symbol: "ORCA",
    name: "Orca",
    decimals: 6,
    verified: true,
  },

  // Liquid staking
  MSOL: {
    mint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
    symbol: "mSOL",
    name: "Marinade Staked SOL",
    decimals: 9,
    verified: true,
  },
  JITOSOL: {
    mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
    symbol: "jitoSOL",
    name: "Jito Staked SOL",
    decimals: 9,
    verified: true,
  },
  BSOL: {
    mint: "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",
    symbol: "bSOL",
    name: "BlazeStake Staked SOL",
    decimals: 9,
    verified: true,
  },

  // Wrapped
  WBTC: {
    mint: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
    symbol: "wBTC",
    name: "Wrapped Bitcoin (Portal)",
    decimals: 8,
    verified: true,
  },
  WETH: {
    mint: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
    symbol: "wETH",
    name: "Wrapped Ether (Portal)",
    decimals: 8,
    verified: true,
  },
};

export interface TokenInfo {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  verified: boolean;
}

export interface TokenResolutionResult {
  mint: string;
  symbol: string;
  name: string;
  decimals: number | null; // null for direct mint addresses (requires on-chain lookup)
  verified: boolean;
  source: "local" | "jupiter" | "direct";
}

/**
 * Check if a string looks like a Solana mint address.
 * Base58 encoded, typically 32-44 characters.
 */
export function isMintAddress(input: string): boolean {
  // Solana addresses are base58, 32-44 chars
  // Most mint addresses are 43-44 chars
  if (input.length < 32 || input.length > 44) return false;

  // Base58 character set (no 0, O, I, l)
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
  return base58Regex.test(input);
}

/**
 * Resolve a token symbol or mint address to a verified mint address.
 *
 * Flow:
 * 1. If input is a mint address → check local directory, then Jupiter, then Helius DAS
 * 2. If input is in local TOKEN_DIRECTORY → return from directory
 * 3. Otherwise → call Jupiter API, filter for isVerified: true
 *
 * @param input Token symbol (e.g., "JUP") or mint address
 * @returns Resolved token info with mint address
 */
export async function resolveTokenMint(input: string): Promise<TokenResolutionResult> {
  // 1. If it looks like a mint address, look up metadata
  if (isMintAddress(input)) {
    logger.debug("Token input is mint address, looking up metadata", { input });

    // Check local directory by mint first
    const localToken = getTokenByMint(input);
    if (localToken) {
      logger.debug("Token found in local directory by mint", { input, symbol: localToken.symbol });
      return {
        mint: input,
        symbol: localToken.symbol,
        name: localToken.name,
        decimals: localToken.decimals,
        verified: localToken.verified,
        source: "local",
      };
    }

    // Try Jupiter API for metadata
    const jupiterMetadata = await fetchTokenMetadataByMint(input);
    if (jupiterMetadata) {
      return {
        mint: input,
        symbol: jupiterMetadata.symbol,
        name: jupiterMetadata.name,
        decimals: jupiterMetadata.decimals,
        verified: jupiterMetadata.verified,
        source: "jupiter",
      };
    }

    // Try Helius DAS as fallback
    const heliusMetadata = await fetchHeliusTokenMetadata(input);
    if (heliusMetadata) {
      return {
        mint: input,
        symbol: heliusMetadata.symbol,
        name: heliusMetadata.name,
        decimals: null, // Helius DAS doesn't return decimals
        verified: false,
        source: "direct",
      };
    }

    // Fallback to unknown
    logger.warn("No metadata found for mint address", { mint: input });
    return {
      mint: input,
      symbol: input.slice(0, 4) + "...",
      name: "Unknown Token",
      decimals: null,
      verified: false,
      source: "direct",
    };
  }

  // 2. Check local directory first (case-insensitive)
  const upperInput = input.toUpperCase();
  const localToken = TOKEN_DIRECTORY[upperInput];

  if (localToken) {
    logger.debug("Token found in local directory", { input, mint: localToken.mint });
    return {
      mint: localToken.mint,
      symbol: localToken.symbol,
      name: localToken.name,
      decimals: localToken.decimals,
      verified: localToken.verified,
      source: "local",
    };
  }

  // 3. Fallback to Jupiter API search
  logger.info("Token not in local directory, searching Jupiter API", { input });

  const searchResult = await searchJupiterToken(input);

  if (searchResult) {
    return {
      mint: searchResult.mint,
      symbol: searchResult.symbol,
      name: searchResult.name,
      decimals: searchResult.decimals,
      verified: searchResult.verified,
      source: "jupiter",
    };
  }

  // No verified token found
  throw new TokenNotFoundError(
    `Token "${input}" not found. Either use a verified token symbol or provide the mint address directly.`
  );
}

/**
 * Search Jupiter API for a token and return the first verified match.
 */
async function searchJupiterToken(query: string): Promise<TokenInfo | null> {
  try {
    const url = `${JUPITER_API_BASE}/tokens/v2/search?query=${encodeURIComponent(query)}`;

    const response = await fetch(url, {
      headers: {
        "x-api-key": config.JUPITER_API_KEY,
      },
    });

    if (!response.ok) {
      logger.error("Jupiter API error", {
        status: response.status,
        statusText: response.statusText
      });
      return null;
    }

    const tokens: JupiterTokenResponse[] = await response.json();

    // Filter for verified tokens only
    const verifiedTokens = tokens.filter((t) => t.isVerified === true);

    if (verifiedTokens.length === 0) {
      logger.warn("No verified tokens found for query", { query });
      return null;
    }

    // Return the first verified token (usually the most relevant)
    const token = verifiedTokens[0];

    logger.info("Found verified token from Jupiter", {
      query,
      mint: token.id,
      symbol: token.symbol,
      name: token.name,
    });

    return {
      mint: token.id,
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
      verified: true,
    };
  } catch (error) {
    logger.error("Failed to search Jupiter API", { query, error: String(error) });
    return null;
  }
}

/**
 * Fetch token metadata from Jupiter API by mint address.
 */
async function fetchTokenMetadataByMint(mint: string): Promise<TokenInfo | null> {
  try {
    const url = `${JUPITER_API_BASE}/tokens/v1/${mint}`;

    logger.debug("Fetching token metadata from Jupiter by mint", { mint });

    const response = await fetch(url, {
      headers: {
        "x-api-key": config.JUPITER_API_KEY,
      },
    });

    if (!response.ok) {
      logger.debug("Jupiter token not found by mint", { mint, status: response.status });
      return null;
    }

    const token = await response.json();

    if (token && token.symbol) {
      logger.debug("Jupiter token metadata found by mint", {
        mint,
        symbol: token.symbol,
        name: token.name,
      });
      return {
        mint: token.address || mint,
        symbol: token.symbol,
        name: token.name || token.symbol,
        decimals: token.decimals,
        verified: token.isVerified ?? false,
      };
    }
  } catch (error) {
    logger.debug("Failed to fetch Jupiter token metadata by mint", {
      mint,
      error: String(error),
    });
  }
  return null;
}

/**
 * Fetch token metadata from Helius DAS API by mint address.
 */
async function fetchHeliusTokenMetadata(mint: string): Promise<{ symbol: string; name: string } | null> {
  try {
    const heliusUrl = `https://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`;

    logger.debug("Fetching token metadata from Helius DAS", { mint });

    const response = await fetch(heliusUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "knot-token-lookup",
        method: "getAsset",
        params: {
          id: mint,
        },
      }),
    });

    if (!response.ok) {
      logger.debug("Helius DAS API request failed", { mint, status: response.status });
      return null;
    }

    const data = await response.json();

    if (data.error) {
      logger.debug("Helius DAS API error", { mint, error: data.error });
      return null;
    }

    if (data.result?.content?.metadata) {
      const metadata = data.result.content.metadata;
      const symbol = metadata.symbol || mint.slice(0, 4) + "...";
      const name = metadata.name || "Unknown Token";

      logger.debug("Helius DAS metadata found", { mint, symbol, name });
      return { symbol, name };
    }
  } catch (error) {
    logger.debug("Failed to fetch Helius DAS metadata", {
      mint,
      error: String(error),
    });
  }
  return null;
}

/**
 * Jupiter API token response structure
 */
interface JupiterTokenResponse {
  id: string; // mint address
  name: string;
  symbol: string;
  decimals: number;
  isVerified: boolean;
  tags: string[];
  // ... other fields we don't need
}

/**
 * Error thrown when a token cannot be resolved
 */
export class TokenNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenNotFoundError";
  }
}

/**
 * Get token info from local directory by mint address.
 * Returns null if not in directory.
 */
export function getTokenByMint(mint: string): TokenInfo | null {
  for (const token of Object.values(TOKEN_DIRECTORY)) {
    if (token.mint === mint) {
      return token;
    }
  }
  return null;
}

/**
 * Get all tokens from local directory
 */
export function getAllLocalTokens(): TokenInfo[] {
  return Object.values(TOKEN_DIRECTORY);
}
