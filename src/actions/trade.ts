import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { connection, signTransaction } from "../turnkey/signer.js";
import { checkPolicy } from "../policy/engine.js";
import { logger } from "../utils/logger.js";
import { TradeError, InsufficientFundsError } from "../utils/errors.js";
import { resolveTokenMint, TOKEN_DIRECTORY } from "../utils/tokens.js";
import { config } from "../config.js";
import { createAuditLog } from "../utils/audit.js";

// Jupiter Ultra API (RPC-less, handles everything)
const JUPITER_ULTRA_API = "https://api.jup.ag/ultra/v1";

// Jupiter Referral Program for fee collection
// Fees are collected automatically by Jupiter into referral token accounts
// Tiered fee structure based on trade USD value (Jupiter takes 20%, so net = bps × 0.8):
//   < $6.25:  255 bps (2.55%) - max fee, nets 2.04%, breakeven at ~$4.90
//   $6.25-$12.50: 200 bps (2%) - nets 1.6%, profitable
//   ≥ $12.50: 100 bps (1%) - nets 0.8%, profitable

// Fee tier thresholds (in USD)
const FEE_TIER_LOW_THRESHOLD = 6.25;    // Below this: max fee (255 bps)
const FEE_TIER_MID_THRESHOLD = 12.50;   // Below this: medium fee (200 bps)

// Fee amounts in basis points
const FEE_BPS_HIGH = 255;   // 2.55% - for trades < $6.25
const FEE_BPS_MEDIUM = 200; // 2.00% - for trades $6.25-$12.50
const FEE_BPS_LOW = 100;    // 1.00% - for trades ≥ $12.50

// Known stablecoin mints (1:1 with USD)
const STABLECOIN_MINTS: Record<string, boolean> = {
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": true, // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": true, // USDT
  "USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX": true,  // USDH
  "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA": true,  // USDS
};

// Wrapped SOL mint
const WSOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Estimate the USD value of a trade based on input token and amount.
 * For stablecoins, amount = USD value directly.
 * For SOL, we fetch the current price.
 * For unknown tokens, return null (will use max fee).
 */
async function estimateTradeUsdValue(
  inputMint: string,
  amount: number
): Promise<number | null> {
  // Stablecoins: 1:1 with USD
  if (STABLECOIN_MINTS[inputMint]) {
    return amount;
  }

  // Fetch price from Jupiter Price API for SOL and any other token
  try {
    const priceResponse = await fetch(
      `https://api.jup.ag/price/v3?ids=${inputMint}`,
      { headers: { "x-api-key": config.JUPITER_API_KEY } }
    ).then((r) => r.json());

    const tokenPrice = priceResponse?.data?.[inputMint]?.usdPrice;
    if (tokenPrice && typeof tokenPrice === "number") {
      return amount * tokenPrice;
    }
  } catch (error) {
    logger.warn("Failed to fetch token price for fee calculation", {
      inputMint,
      error: String(error),
    });
  }

  // SOL fallback: assume ~$150 (conservative, triggers higher fee tier)
  if (inputMint === WSOL_MINT) {
    return amount * 150;
  }

  // Unknown token with no price data: return null to trigger max fee
  return null;
}

/**
 * Calculate the appropriate referral fee tier based on estimated USD value.
 * Returns fee in basis points (50-255 range for Jupiter).
 */
function calculateFeeTier(estimatedUsdValue: number | null): number {
  // Unknown value: use max fee to be safe
  if (estimatedUsdValue === null) {
    return FEE_BPS_HIGH;
  }

  // Tiered fee structure
  if (estimatedUsdValue < FEE_TIER_LOW_THRESHOLD) {
    return FEE_BPS_HIGH;  // 255 bps for < $6.25
  } else if (estimatedUsdValue < FEE_TIER_MID_THRESHOLD) {
    return FEE_BPS_MEDIUM; // 200 bps for $6.25-$12.50
  } else {
    return FEE_BPS_LOW;    // 100 bps for ≥ $12.50
  }
}

export interface TradeResult {
  signature: string;
  explorerUrl: string;
  inputMint: string;
  outputMint: string;
  inputAmount: string;
  outputAmount: string;
  feeBps: number; // fee in basis points collected by Jupiter referral
  feeMint: string | null; // token mint where fee was collected
  priceImpact: string;
}

/**
 * Swap tokens via Jupiter Ultra API.
 * Jupiter handles routing, MEV protection, slippage, and transaction landing.
 *
 * @param fromMint  Input token mint address (or symbol like "USDC")
 * @param toMint    Output token mint address (or symbol like "SOL")
 * @param amount    Amount in human units (e.g. 10 for 10 USDC)
 * @param slippageBps Slippage tolerance in basis points (50 = 0.5%) - used in manual mode only
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
  const fromResolved = await resolveTokenMint(fromToken);
  const toResolved = await resolveTokenMint(toToken);

  const inputMint = fromResolved.mint;
  const outputMint = toResolved.mint;

  logger.debug("Initiating trade via Ultra API", {
    fromSymbol: fromResolved.symbol,
    toSymbol: toResolved.symbol,
    amount,
  });

  // Get token decimals for amount conversion
  const inputDecimals = fromResolved.decimals ?? await getTokenDecimals(inputMint);
  const amountLamports = Math.floor(amount * Math.pow(10, inputDecimals));

  // Calculate tiered fee based on estimated USD value
  const estimatedUsdValue = await estimateTradeUsdValue(inputMint, amount);

  if (estimatedUsdValue === null) {
    logger.warn("Could not determine USD value for trade — using max fee tier", {
      inputMint,
      amount,
    });
  }

  // Policy check BEFORE making any Jupiter API calls
  await checkPolicy(agentId, {
    type: "trade",
    usdValue: estimatedUsdValue ?? 0,
    fromMint: inputMint,
    toMint: outputMint,
    amount,
  });

  // Jupiter referral configuration with tiered fees
  const referralAccount = config.JUPITER_REFERRAL_ACCOUNT;
  const hasReferral = !!referralAccount;
  const referralFeeBps = calculateFeeTier(estimatedUsdValue);

  if (!hasReferral) {
    logger.warn("Jupiter referral account not configured", {
      referralAccount: referralAccount || "not set",
    });
  }

  logger.info("Trade fee tier calculated", {
    estimatedUsdValue: estimatedUsdValue?.toFixed(2) ?? "unknown",
    feeBps: referralFeeBps,
    feeTier: estimatedUsdValue === null ? "unknown_token" :
      estimatedUsdValue < FEE_TIER_LOW_THRESHOLD ? "high" :
      estimatedUsdValue < FEE_TIER_MID_THRESHOLD ? "medium" : "low",
  });

  const jupiterHeaders = {
    "Content-Type": "application/json",
    "x-api-key": config.JUPITER_API_KEY,
  };

  // Step 1: Get order from Jupiter Ultra API with referral fee
  const orderParams = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amountLamports.toString(),
    taker: agentAddress,
  });

  // Add referral parameters if configured
  if (hasReferral) {
    orderParams.set("referralAccount", referralAccount);
    orderParams.set("referralFee", referralFeeBps.toString());
  }

  const orderUrl = `${JUPITER_ULTRA_API}/order?${orderParams}`;
  logger.info("Jupiter Ultra order request", {
    url: orderUrl,
    inputMint,
    outputMint,
    amount,
    amountLamports,
    taker: agentAddress,
    referralAccount: hasReferral ? referralAccount : "none",
    referralFeeBps: hasReferral ? referralFeeBps : 0,
  });

  const orderResponse = await fetch(orderUrl, {
    headers: jupiterHeaders,
  }).then((r) => r.json());

  logger.info("Jupiter Ultra order response", {
    hasTransaction: !!orderResponse.transaction,
    requestId: orderResponse.requestId,
    router: orderResponse.router,
    inAmount: orderResponse.inAmount,
    outAmount: orderResponse.outAmount,
    feeBps: orderResponse.feeBps,
    feeMint: orderResponse.feeMint,
    errorCode: orderResponse.errorCode,
    errorMessage: orderResponse.errorMessage,
  });

  // Handle errors
  if (orderResponse.errorCode || orderResponse.errorMessage) {
    const errorMsg = orderResponse.errorMessage || `Error code: ${orderResponse.errorCode}`;
    
    // Map specific error codes to user-friendly messages
    if (orderResponse.errorCode === 1) {
      throw new InsufficientFundsError(`Insufficient ${fromResolved.symbol} balance for this swap`);
    }
    if (orderResponse.errorCode === 2) {
      throw new TradeError(`Insufficient SOL for gas fees. ${errorMsg}`);
    }
    
    throw new TradeError(`Jupiter order error: ${errorMsg}`);
  }

  // Handle "Route not found" / no transaction
  if (!orderResponse.transaction) {
    throw new TradeError(
      `No swap route found for ${fromResolved.symbol} → ${toResolved.symbol}. ` +
      `This token pair may not have sufficient liquidity on Jupiter.`
    );
  }

  // Step 2: Deserialize and sign the transaction via Turnkey
  const transactionBuf = Buffer.from(orderResponse.transaction, "base64");
  const transaction = VersionedTransaction.deserialize(transactionBuf);

  let signedTransaction: string;
  try {
    signedTransaction = await signTransaction(transaction, agentAddress, subOrgId);
  } catch (error) {
    await logTradeError(agentId, fromResolved.symbol, toResolved.symbol, amount, inputMint, outputMint, error, {
      feeBps: orderResponse.feeBps,
      feeMint: orderResponse.feeMint,
    });
    throw error;
  }

  // Step 3: Execute via Jupiter Ultra (Jupiter handles broadcasting)
  logger.info("Jupiter Ultra execute request", { requestId: orderResponse.requestId });

  const executeResponse = await fetch(`${JUPITER_ULTRA_API}/execute`, {
    method: "POST",
    headers: jupiterHeaders,
    body: JSON.stringify({
      signedTransaction,
      requestId: orderResponse.requestId,
    }),
  }).then((r) => r.json());

  logger.info("Jupiter Ultra execute response", {
    status: executeResponse.status,
    signature: executeResponse.signature,
    error: executeResponse.error,
  });

  if (executeResponse.status === "Failed" || executeResponse.error) {
    await logTradeError(
      agentId,
      fromResolved.symbol,
      toResolved.symbol,
      amount,
      inputMint,
      outputMint,
      new Error(executeResponse.error || "Execution failed"),
      { feeBps: orderResponse.feeBps, feeMint: orderResponse.feeMint }
    );
    throw new TradeError(`Trade execution failed: ${executeResponse.error || "Unknown error"}`);
  }

  const signature = executeResponse.signature;
  const outputDecimals = toResolved.decimals ?? await getTokenDecimals(outputMint);
  const outputAmount = (
    parseInt(executeResponse.outputAmountResult || orderResponse.outAmount) / Math.pow(10, outputDecimals)
  ).toFixed(6);

  // Fee info from Jupiter response
  const feeBps = orderResponse.feeBps || 0;
  const feeMint = orderResponse.feeMint || null;

  // Log successful trade
  await createAuditLog({
    agentId,
    action: "trade",
    asset: fromResolved.symbol,
    amount,
    to: toResolved.symbol,
    signature,
    status: "confirmed",
    normalizedUsdAmount: estimatedUsdValue,
    metadata: {
      inputMint,
      outputMint,
      outputAmount: parseFloat(outputAmount),
      feeBps,
      feeMint,
      feeCollectedViaReferral: hasReferral && feeBps > 0,
      priceImpact: orderResponse.priceImpact || orderResponse.priceImpactPct,
      router: orderResponse.router,
      gasless: orderResponse.gasless,
      route: orderResponse.routePlan?.map((r: { swapInfo: { label: string } }) => r.swapInfo?.label),
      usdValue: estimatedUsdValue ?? 0, // For daily limit calculation
    },
  });

  logger.info("Trade completed via Ultra API", {
    signature,
    router: orderResponse.router,
    feeBps,
    feeMint,
  });

  return {
    signature,
    explorerUrl: `https://solscan.io/tx/${signature}`,
    inputMint,
    outputMint,
    inputAmount: `${amount} ${fromResolved.symbol}`,
    outputAmount: `${outputAmount} ${toResolved.symbol}`,
    feeBps,
    feeMint,
    priceImpact: `${orderResponse.priceImpact || orderResponse.priceImpactPct || 0}%`,
  };
}

// Helper: log trade errors to audit log
async function logTradeError(
  agentId: string,
  fromSymbol: string,
  toSymbol: string,
  amount: number,
  inputMint: string,
  outputMint: string,
  error: unknown,
  feeInfo?: { feeBps?: number; feeMint?: string }
): Promise<void> {
  await createAuditLog({
    agentId,
    action: "trade",
    asset: fromSymbol,
    amount,
    to: toSymbol,
    status: "failed",
    metadata: {
      inputMint,
      outputMint,
      error: String(error),
      ...(feeInfo && { feeBps: feeInfo.feeBps, feeMint: feeInfo.feeMint }),
    },
  });
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
