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

  await checkPolicy(agentId, {
    type: "trade",
    fromMint: inputMint,
    toMint: outputMint,
    amount,
  });

  // Get token decimals for amount conversion
  const inputDecimals = fromResolved.decimals ?? await getTokenDecimals(inputMint);
  const amountLamports = Math.floor(amount * Math.pow(10, inputDecimals));

  const jupiterHeaders = {
    "Content-Type": "application/json",
    "x-api-key": config.JUPITER_API_KEY,
  };

  // Step 1: Get order from Jupiter Ultra API
  const orderParams = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amountLamports.toString(),
    taker: agentAddress,
  });

  const orderUrl = `${JUPITER_ULTRA_API}/order?${orderParams}`;
  logger.info("Jupiter Ultra order request", {
    url: orderUrl,
    inputMint,
    outputMint,
    amount,
    amountLamports,
    taker: agentAddress,
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
    await logTradeError(agentId, fromResolved.symbol, toResolved.symbol, amount, inputMint, outputMint, error);
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
      new Error(executeResponse.error || "Execution failed")
    );
    throw new TradeError(`Trade execution failed: ${executeResponse.error || "Unknown error"}`);
  }

  const signature = executeResponse.signature;
  const outputDecimals = toResolved.decimals ?? await getTokenDecimals(outputMint);
  const outputAmount = (
    parseInt(executeResponse.outputAmountResult || orderResponse.outAmount) / Math.pow(10, outputDecimals)
  ).toFixed(6);

  // Log successful trade
  await createAuditLog({
    agentId,
    action: "trade",
    asset: fromResolved.symbol,
    amount,
    to: toResolved.symbol,
    signature,
    status: "confirmed",
    metadata: {
      inputMint,
      outputMint,
      outputAmount: parseFloat(outputAmount),
      priceImpact: orderResponse.priceImpact || orderResponse.priceImpactPct,
      router: orderResponse.router,
      gasless: orderResponse.gasless,
      route: orderResponse.routePlan?.map((r: { swapInfo: { label: string } }) => r.swapInfo?.label),
    },
  });

  logger.info("Trade completed via Ultra API", { signature, router: orderResponse.router });

  return {
    signature,
    explorerUrl: `https://solscan.io/tx/${signature}`,
    inputMint,
    outputMint,
    inputAmount: `${amount} ${fromResolved.symbol}`,
    outputAmount: `${outputAmount} ${toResolved.symbol}`,
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
  error: unknown
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
