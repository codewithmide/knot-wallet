import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { connection } from "../turnkey/signer.js";
import { logger } from "./logger.js";
import { config } from "../config.js";

const JUPITER_API_BASE = "https://api.jup.ag";

// Known token metadata for common tokens
const TOKEN_METADATA: Record<string, { symbol: string; name: string }> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", name: "USD Coin" },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: "USDT", name: "Tether USD" },
  "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH": { symbol: "USDG", name: "Global Dollar" },
  So11111111111111111111111111111111111111112: { symbol: "WSOL", name: "Wrapped SOL" },
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: { symbol: "JUP", name: "Jupiter" },
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: { symbol: "BONK", name: "Bonk" },
  "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr": { symbol: "POPCAT", name: "Popcat" },
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: { symbol: "WIF", name: "dogwifhat" },
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: { symbol: "mSOL", name: "Marinade Staked SOL" },
  "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj": { symbol: "stSOL", name: "Lido Staked SOL" },
  HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3: { symbol: "PYTH", name: "Pyth Network" },
  RLBxxFkseAZ4RgJH3Sqn8jXxhmGoz9jWxDNJMh8pL7a: { symbol: "RLB", name: "Rollbit Coin" },
  jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: { symbol: "JTO", name: "Jito" },
  TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6: { symbol: "TNSR", name: "Tensor" },
  "85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ": { symbol: "W", name: "Wormhole" },
};

export interface TokenBalance {
  mint: string;
  symbol: string;
  name: string;
  balance: number;
  decimals: number;
}

export interface WalletBalances {
  sol: number;
  tokens: TokenBalance[];
  totalTokens: number;
  address: string;
}

/**
 * Get SOL and all SPL token balances for a wallet address.
 */
export async function getBalances(address: string): Promise<WalletBalances> {
  const publicKey = new PublicKey(address);

  // Get SOL balance
  const solBalance = await connection.getBalance(publicKey);
  const sol = solBalance / LAMPORTS_PER_SOL;

  logger.debug("Raw SOL balance from RPC", { address, solBalance, solInSOL: sol });

  // Get ALL SPL token balances (both standard Token Program and Token-2022)
  const [tokenAccounts, token2022Accounts] = await Promise.all([
    connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_PROGRAM_ID }),
    connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_2022_PROGRAM_ID }),
  ]);

  // Merge both token account lists
  const allTokenAccounts = [...tokenAccounts.value, ...token2022Accounts.value];

  logger.debug("Token accounts fetched", {
    address,
    accountCount: allTokenAccounts.length,
    standardTokens: tokenAccounts.value.length,
    token2022Tokens: token2022Accounts.value.length,
  });

  // Extract token data from accounts
  const tokenDataList = allTokenAccounts
    .map((account) => {
      const parsed = account.account.data.parsed.info;
      return {
        mint: parsed.mint as string,
        balance: (parsed.tokenAmount.uiAmount ?? 0) as number,
        decimals: parsed.tokenAmount.decimals as number,
      };
    })
    .filter((t) => t.balance > 0);

  // Find mints that need metadata lookup
  const unknownMints = tokenDataList
    .map((t) => t.mint)
    .filter((mint) => !TOKEN_METADATA[mint]);

  logger.debug("Token metadata lookup", {
    totalTokens: tokenDataList.length,
    knownTokens: tokenDataList.length - unknownMints.length,
    unknownCount: unknownMints.length,
  });

  // Fetch metadata for unknown tokens from Jupiter
  const jupiterMetadata = await fetchJupiterTokenMetadata(unknownMints);

  // Build final token list with metadata
  const tokens: TokenBalance[] = tokenDataList
    .map((tokenData) => {
      // Check local metadata first
      let metadata = TOKEN_METADATA[tokenData.mint];

      // If not found locally, check Jupiter metadata
      if (!metadata && jupiterMetadata[tokenData.mint]) {
        metadata = jupiterMetadata[tokenData.mint];
        logger.debug("Using Jupiter metadata for token", {
          mint: tokenData.mint,
          symbol: metadata.symbol,
          name: metadata.name,
        });
      }

      // Fallback to truncated mint
      if (!metadata) {
        metadata = {
          symbol: tokenData.mint.slice(0, 4) + "...",
          name: "Unknown Token",
        };
        logger.warn("No metadata found for token", { mint: tokenData.mint });
      }

      return {
        mint: tokenData.mint,
        symbol: metadata.symbol,
        name: metadata.name,
        balance: tokenData.balance,
        decimals: tokenData.decimals,
      };
    })
    // Sort by balance (highest first)
    .sort((a, b) => b.balance - a.balance);

  const result = {
    sol,
    tokens,
    totalTokens: tokens.length,
    address,
  };

  logger.debug("Processed balance result", { address, sol, tokenCount: tokens.length });

  return result;
}

/**
 * Get balance for a specific token mint
 */
export async function getTokenBalance(
  address: string,
  mintAddress: string
): Promise<TokenBalance | null> {
  const balances = await getBalances(address);
  return balances.tokens.find((t) => t.mint === mintAddress) || null;
}

/**
 * Fetch token metadata from Jupiter API for a list of mint addresses.
 * Falls back to Helius DAS API for tokens not found in Jupiter.
 * Returns a map of mint address -> { symbol, name }
 */
async function fetchJupiterTokenMetadata(
  mints: string[]
): Promise<Record<string, { symbol: string; name: string }>> {
  if (mints.length === 0) {
    return {};
  }

  const result: Record<string, { symbol: string; name: string }> = {};
  const notFoundInJupiter: string[] = [];

  // Step 1: Try Jupiter API first
  const jupiterPromises = mints.map(async (mint) => {
    try {
      const url = `${JUPITER_API_BASE}/tokens/v1/${mint}`;

      logger.debug("Fetching token metadata from Jupiter", { mint, url });

      const response = await fetch(url, {
        headers: {
          "x-api-key": config.JUPITER_API_KEY,
        },
      });

      if (!response.ok) {
        logger.debug("Jupiter token not found", { mint, status: response.status });
        return { mint, found: false };
      }

      const token = await response.json();

      if (token && token.symbol) {
        logger.debug("Jupiter token metadata found", {
          mint,
          symbol: token.symbol,
          name: token.name,
        });
        return {
          mint,
          found: true,
          symbol: token.symbol,
          name: token.name || token.symbol,
        };
      }
    } catch (error) {
      logger.debug("Failed to fetch Jupiter token metadata", {
        mint,
        error: String(error),
      });
    }
    return { mint, found: false };
  });

  const jupiterResults = await Promise.all(jupiterPromises);

  for (const tokenData of jupiterResults) {
    if (tokenData.found && tokenData.symbol) {
      result[tokenData.mint] = {
        symbol: tokenData.symbol,
        name: tokenData.name || tokenData.symbol,
      };
    } else {
      notFoundInJupiter.push(tokenData.mint);
    }
  }

  logger.debug("Jupiter token metadata lookup complete", {
    requested: mints.length,
    foundInJupiter: Object.keys(result).length,
    notFoundCount: notFoundInJupiter.length,
  });

  // Step 2: Try Helius DAS API for tokens not found in Jupiter
  if (notFoundInJupiter.length > 0) {
    const heliusMetadata = await fetchHeliusDASMetadata(notFoundInJupiter);
    Object.assign(result, heliusMetadata);
  }

  return result;
}

/**
 * Fetch token metadata from Helius DAS API.
 * Uses getAssetBatch for efficient batch lookups.
 */
async function fetchHeliusDASMetadata(
  mints: string[]
): Promise<Record<string, { symbol: string; name: string }>> {
  const result: Record<string, { symbol: string; name: string }> = {};

  if (mints.length === 0) {
    return result;
  }

  try {
    const heliusUrl = `https://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`;

    logger.debug("Fetching token metadata from Helius DAS", { mintCount: mints.length });

    const response = await fetch(heliusUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "knot-balance-lookup",
        method: "getAssetBatch",
        params: {
          ids: mints,
        },
      }),
    });

    if (!response.ok) {
      logger.error("Helius DAS API request failed", {
        status: response.status,
        statusText: response.statusText,
      });
      return result;
    }

    const data = await response.json();

    if (data.error) {
      logger.error("Helius DAS API error", { error: data.error });
      return result;
    }

    // Process the batch results
    if (Array.isArray(data.result)) {
      for (const asset of data.result) {
        if (asset && asset.id && asset.content?.metadata) {
          const metadata = asset.content.metadata;
          const symbol = metadata.symbol || asset.id.slice(0, 4) + "...";
          const name = metadata.name || "Unknown Token";

          result[asset.id] = { symbol, name };

          logger.debug("Helius DAS metadata found", {
            mint: asset.id,
            symbol,
            name,
          });
        }
      }
    }

    logger.debug("Helius DAS metadata lookup complete", {
      requested: mints.length,
      found: Object.keys(result).length,
    });
  } catch (error) {
    logger.error("Failed to fetch Helius DAS metadata", {
      error: String(error),
      mints,
    });
  }

  return result;
}
