import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { connection, signAndBroadcast } from "../turnkey/signer.js";
import { checkPolicy } from "../policy/engine.js";
import { db } from "../db/prisma.js";
import { logger } from "../utils/logger.js";
import { resolveTokenMint, TOKEN_DIRECTORY } from "../utils/tokens.js";
import { config } from "../config.js";

// Jupiter API v2 (requires API key)
const JUPITER_API_BASE = "https://api.jup.ag/swap/v2";

export interface TradeResult {
  signature: string;
  explorerUrl: string;
  inputMint: string;
  outputMint: string;
  inputAmount: string;
  outputAmount: string;
  priceImpact: string;
}

/**
 * Swap tokens via Jupiter.
 * Jupiter handles routing, MEV protection, and slippage automatically.
 *
 * @param fromMint  Input token mint address (or symbol like "USDC")
 * @param toMint    Output token mint address (or symbol like "SOL")
 * @param amount    Amount in human units (e.g. 10 for 10 USDC)
 * @param slippageBps Slippage tolerance in basis points (50 = 0.5%)
 */
export async function trade(
  agentAddress: string,
  agentId: string,
  subOrgId: string,
  fromToken: string,
  toToken: string,
  amount: number,
  slippageBps: number = 50
): Promise<TradeResult> {
  // Resolve symbol or mint address to verified mint
  // - If mint address provided: use directly (no verification)
  // - If symbol provided: check local directory, then Jupiter API (verified only)
  const fromResolved = await resolveTokenMint(fromToken);
  const toResolved = await resolveTokenMint(toToken);

  const inputMint = fromResolved.mint;
  const outputMint = toResolved.mint;

  logger.debug("Initiating trade", {
    fromSymbol: fromResolved.symbol,
    toSymbol: toResolved.symbol,
    amount,
  });

  await checkPolicy(agentId, {
    type: "trade",
    fromMint: inputMint,
    toMint: outputMint,
    amount,
  });

  // Get token decimals for amount conversion
  // Use resolved decimals when available, fallback to on-chain lookup
  const inputDecimals = fromResolved.decimals ?? await getTokenDecimals(inputMint);
  const amountLamports = Math.floor(amount * Math.pow(10, inputDecimals));

  // Step 1: Get quote from Jupiter
  const quoteParams = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amountLamports.toString(),
    slippageBps: slippageBps.toString(),
  });

  const jupiterHeaders = {
    "Content-Type": "application/json",
    "x-api-key": config.JUPITER_API_KEY,
  };

  const quoteResponse = await fetch(
    `${JUPITER_API_BASE}/quote?${quoteParams}`,
    { headers: jupiterHeaders }
  ).then((r) => r.json());

  if (quoteResponse.error || quoteResponse.code) {
    throw new Error(`Jupiter quote error: ${quoteResponse.error || quoteResponse.message}`);
  }

  // Step 2: Get serialized swap transaction from Jupiter
  const swapResponse = await fetch(`${JUPITER_API_BASE}/swap`, {
    method: "POST",
    headers: jupiterHeaders,
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: agentAddress,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  }).then((r) => r.json());

  if (swapResponse.error || swapResponse.code) {
    throw new Error(`Jupiter swap error: ${swapResponse.error || swapResponse.message}`);
  }

  // Step 3: Deserialize the unsigned transaction
  const swapTransactionBuf = Buffer.from(
    swapResponse.swapTransaction,
    "base64"
  );
  const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

  // Step 4: Sign and broadcast via Turnkey
  let signature: string;
  let status: string = "confirmed";

  try {
    signature = await signAndBroadcast(transaction, agentAddress, subOrgId);
  } catch (error) {
    status = "failed";
    await db.auditLog.create({
      data: {
        agentId,
        action: "trade",
        asset: fromResolved.symbol,
        amount,
        to: toResolved.symbol,
        status,
        metadata: {
          inputMint,
          outputMint,
          error: String(error),
        },
      },
    });
    throw error;
  }

  const outputDecimals = toResolved.decimals ?? await getTokenDecimals(outputMint);
  const outputAmount = (
    parseInt(quoteResponse.outAmount) / Math.pow(10, outputDecimals)
  ).toFixed(6);

  // Log successful trade
  await db.auditLog.create({
    data: {
      agentId,
      action: "trade",
      asset: fromResolved.symbol,
      amount,
      to: toResolved.symbol,
      signature,
      status,
      metadata: {
        inputMint,
        outputMint,
        outputAmount: parseFloat(outputAmount),
        priceImpact: quoteResponse.priceImpactPct,
        route: quoteResponse.routePlan?.map((r: { swapInfo: { label: string } }) => r.swapInfo?.label),
      },
    },
  });

  logger.debug("Trade completed", { signature });

  return {
    signature,
    explorerUrl: `https://solscan.io/tx/${signature}`,
    inputMint,
    outputMint,
    inputAmount: `${amount} ${fromResolved.symbol}`,
    outputAmount: `${outputAmount} ${toResolved.symbol}`,
    priceImpact: `${quoteResponse.priceImpactPct}%`,
  };
}

// Helper: get token decimal places from on-chain mint account
async function getTokenDecimals(mint: string): Promise<number> {
  // Check local directory first
  for (const token of Object.values(TOKEN_DIRECTORY)) {
    if (token.mint === mint) {
      return token.decimals;
    }
  }

  // Fallback to on-chain lookup
  // Try standard Token Program first, then Token-2022 (Token Extensions)
  const mintPubkey = new PublicKey(mint);

  try {
    const mintInfo = await getMint(connection, mintPubkey);
    return mintInfo.decimals;
  } catch (error) {
    // If standard Token Program fails, try Token-2022
    if (
      error instanceof Error &&
      error.name === "TokenInvalidAccountOwnerError"
    ) {
      const { TOKEN_2022_PROGRAM_ID } = await import("@solana/spl-token");
      const mintInfo = await getMint(
        connection,
        mintPubkey,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      return mintInfo.decimals;
    }
    throw error;
  }
}
