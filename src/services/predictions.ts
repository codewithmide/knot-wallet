import { db } from "../db/prisma.js";
import { logger } from "../utils/logger.js";
import { createAuditLog } from "../utils/audit.js";
import {
  kalshiRequest,
  CreateOrderRequest,
  CreateOrderResponse,
  KalshiMarket,
} from "../kalshi/client.js";
import { config } from "../config.js";
import { connection, signAndBroadcast, signAndBroadcastAdmin } from "../turnkey/signer.js";
import {
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
} from "@solana/web3.js";
import {
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getMint,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

// Fee configuration
const FEE_PERCENTAGE = 0.01;  // 1%
const FLAT_FEE_CENTS = 10;    // $0.10 flat fee per transaction (for Turnkey costs)

// USDC mint address (mainnet)
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

// Deposit expiration time (30 minutes)
const DEPOSIT_EXPIRATION_MINUTES = 30;

// =============================================================================
// Types
// =============================================================================

export interface PredictionBalanceInfo {
  balanceCents: number;
  balanceDollars: number;
}

export interface DepositInitiationResult {
  depositId: string;
  usdcAmount: number;
  usdCents: number;
  expiresAt: string;
  instructions: string;
}

export interface DepositConfirmationResult {
  depositId: string;
  usdcAmount: number;
  usdCents: number;
  newBalanceDollars: number;
  status: string;
}

export interface DepositResult {
  depositId: string;
  usdcAmount: number;
  usdCents: number;
  status: string;
}

export interface WithdrawResult {
  withdrawalId: string;
  usdCents: number;
  usdcAmount: number;
  status: string;
}

export interface BuyResult {
  orderId: string;
  ticker: string;
  side: "yes" | "no";
  count: number;
  pricePerContract: number;
  totalCost: number;
  feeCents: number;
  newBalance: number;
}

export interface SellResult {
  orderId: string;
  ticker: string;
  side: "yes" | "no";
  count: number;
  pricePerContract: number;
  totalProceeds: number;
  feeCents: number;
  newBalance: number;
}

export interface AgentPosition {
  ticker: string;
  eventTicker: string | null;
  side: "yes" | "no";
  quantity: number;
  averageCost: number;
  totalCost: number;
  currentPrice: number | null;
  currentValue: number | null;
  unrealizedPnl: number | null;
  settled: boolean;
  settlementResult: string | null;
  settlementPayout: number | null;
}

// =============================================================================
// Balance Management
// =============================================================================

/**
 * Get or create prediction balance for an agent.
 */
export async function getOrCreatePredictionBalance(agentId: string) {
  let balance = await db.predictionBalance.findUnique({
    where: { agentId },
  });

  if (!balance) {
    balance = await db.predictionBalance.create({
      data: { agentId, balance: 0 },
    });
    logger.info("Created prediction balance for agent", { agentId });
  }

  return balance;
}

/**
 * Get agent's prediction balance.
 */
export async function getPredictionBalance(
  agentId: string
): Promise<PredictionBalanceInfo> {
  const balance = await getOrCreatePredictionBalance(agentId);

  return {
    balanceCents: balance.balance,
    balanceDollars: balance.balance / 100,
  };
}

/**
 * Check if admin wallet is configured
 */
export function isAdminWalletConfigured(): boolean {
  return !!(config.KNOT_KALSHI_ADMIN_KEY_ID && config.KNOT_KALSHI_ADMIN_WALLET_ADDRESS);
}

/**
 * Initiate a prediction deposit.
 * Creates a pending deposit record and returns instructions.
 * The agent must then transfer USDC to complete the deposit.
 *
 * @param agentId Agent ID
 * @param agentWalletAddress Agent's Solana wallet address
 * @param usdcAmount Amount of USDC to deposit
 */
export async function initiatePredictionDeposit(
  agentId: string,
  agentWalletAddress: string,
  usdcAmount: number
): Promise<DepositInitiationResult> {
  if (!isAdminWalletConfigured()) {
    throw new Error("Prediction markets deposit is not configured");
  }

  const usdCents = Math.floor(usdcAmount * 100);
  const expiresAt = new Date(Date.now() + DEPOSIT_EXPIRATION_MINUTES * 60 * 1000);

  logger.info("Initiating prediction deposit", {
    agentId,
    agentWalletAddress,
    usdcAmount,
    usdCents,
  });

  // Create pending deposit record
  const pendingDeposit = await db.pendingPredictionDeposit.create({
    data: {
      agentId,
      agentWalletAddress,
      usdcAmount,
      usdCents,
      expiresAt,
      status: "pending",
    },
  });

  logger.info("Pending deposit created", {
    depositId: pendingDeposit.id,
    agentId,
    usdcAmount,
  });

  return {
    depositId: pendingDeposit.id,
    usdcAmount,
    usdCents,
    expiresAt: expiresAt.toISOString(),
    instructions: `Transfer ${usdcAmount} USDC using POST /wallets/me/actions/fund-predictions with depositId: ${pendingDeposit.id}`,
  };
}

/**
 * Complete a prediction deposit by transferring USDC from agent to admin wallet.
 * Called via the /actions/fund-predictions endpoint.
 *
 * @param agentId Agent ID
 * @param depositId The pending deposit ID from initiatePredictionDeposit
 * @param agentWalletAddress Agent's Solana wallet address
 * @param subOrgId Agent's Turnkey sub-org ID for signing
 */
export async function completePredictionDeposit(
  agentId: string,
  depositId: string,
  agentWalletAddress: string,
  subOrgId: string
): Promise<DepositConfirmationResult> {
  if (!isAdminWalletConfigured()) {
    throw new Error("Prediction markets deposit is not configured");
  }

  // Find the pending deposit
  const pendingDeposit = await db.pendingPredictionDeposit.findUnique({
    where: { id: depositId },
  });

  if (!pendingDeposit) {
    throw new Error(`Deposit ${depositId} not found`);
  }

  if (pendingDeposit.agentId !== agentId) {
    throw new Error("Deposit does not belong to this agent");
  }

  if (pendingDeposit.status !== "pending") {
    throw new Error(`Deposit is already ${pendingDeposit.status}`);
  }

  if (new Date() > pendingDeposit.expiresAt) {
    // Mark as expired
    await db.pendingPredictionDeposit.update({
      where: { id: depositId },
      data: { status: "expired" },
    });
    throw new Error("Deposit has expired. Please initiate a new deposit.");
  }

  if (pendingDeposit.agentWalletAddress !== agentWalletAddress) {
    throw new Error("Wallet address mismatch");
  }

  const adminWalletAddress = config.KNOT_KALSHI_ADMIN_WALLET_ADDRESS;
  const usdcAmount = pendingDeposit.usdcAmount;
  const usdCents = pendingDeposit.usdCents;

  logger.info("Completing prediction deposit", {
    depositId,
    agentId,
    agentWalletAddress,
    usdcAmount,
  });

  // Transfer USDC from agent wallet to admin wallet
  const signature = await transferUSDCToAdmin(
    agentWalletAddress,
    adminWalletAddress,
    usdcAmount,
    subOrgId
  );

  // Get or create prediction balance
  const predictionBalance = await getOrCreatePredictionBalance(agentId);

  // Update database in a transaction
  const result = await db.$transaction(async (tx) => {
    // Mark pending deposit as completed
    await tx.pendingPredictionDeposit.update({
      where: { id: depositId },
      data: {
        status: "completed",
        solanaSignature: signature,
        confirmedAt: new Date(),
      },
    });

    // Create confirmed deposit record
    const deposit = await tx.predictionDeposit.create({
      data: {
        agentId,
        predictionBalanceId: predictionBalance.id,
        usdcAmount,
        usdCents,
        solanaSignature: signature,
        pendingDepositId: depositId,
        status: "confirmed",
        confirmedAt: new Date(),
      },
    });

    // Update balance
    const updatedBalance = await tx.predictionBalance.update({
      where: { id: predictionBalance.id },
      data: { balance: { increment: usdCents } },
    });

    return { deposit, newBalance: updatedBalance.balance };
  });

  // Audit log
  await createAuditLog({
    agentId,
    action: "prediction_deposit",
    asset: "usdc",
    amount: usdcAmount,
    from: agentWalletAddress,
    to: adminWalletAddress,
    signature,
    status: "confirmed",
    metadata: {
      depositId: result.deposit.id,
      pendingDepositId: depositId,
      usdCents,
    },
  });

  logger.info("Prediction deposit completed", {
    agentId,
    depositId: result.deposit.id,
    usdCents,
    signature,
  });

  return {
    depositId: result.deposit.id,
    usdcAmount,
    usdCents,
    newBalanceDollars: result.newBalance / 100,
    status: "confirmed",
  };
}

/**
 * Internal: Transfer USDC from agent wallet to admin wallet
 */
async function transferUSDCToAdmin(
  fromAddress: string,
  toAddress: string,
  amount: number,
  subOrgId: string
): Promise<string> {
  const fromPubkey = new PublicKey(fromAddress);
  const toPubkey = new PublicKey(toAddress);

  // Get mint info for decimals
  const mintInfo = await getMint(connection, USDC_MINT);
  const decimals = mintInfo.decimals;
  const rawAmount = Math.floor(amount * Math.pow(10, decimals));

  // Get token accounts
  const fromTokenAccount = await getAssociatedTokenAddress(
    USDC_MINT,
    fromPubkey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const toTokenAccount = await getAssociatedTokenAddress(
    USDC_MINT,
    toPubkey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // Verify sender has sufficient balance
  try {
    const fromAccountInfo = await getAccount(connection, fromTokenAccount, undefined, TOKEN_PROGRAM_ID);
    if (Number(fromAccountInfo.amount) < rawAmount) {
      throw new Error(
        `Insufficient USDC balance. Have ${Number(fromAccountInfo.amount) / Math.pow(10, decimals)}, need ${amount}`
      );
    }
  } catch (error) {
    if ((error as Error).name === "TokenAccountNotFoundError") {
      throw new Error(`No USDC account found. Balance is 0.`);
    }
    throw error;
  }

  const { blockhash } = await connection.getLatestBlockhash();
  const instructions = [];

  // Create recipient token account if needed
  const toAccountInfo = await connection.getAccountInfo(toTokenAccount);
  if (!toAccountInfo) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        fromPubkey, // payer
        toTokenAccount,
        toPubkey,
        USDC_MINT,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  // Transfer USDC
  instructions.push(
    createTransferCheckedInstruction(
      fromTokenAccount,
      USDC_MINT,
      toTokenAccount,
      fromPubkey,
      rawAmount,
      decimals,
      [],
      TOKEN_PROGRAM_ID
    )
  );

  const message = new TransactionMessage({
    payerKey: fromPubkey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const transaction = new VersionedTransaction(message);

  // Sign and broadcast using agent's sub-org
  const signature = await signAndBroadcast(transaction, fromAddress, subOrgId);

  logger.info("USDC transfer to admin completed", { signature, amount });

  return signature;
}

/**
 * Legacy: Deposit USDC to prediction balance (for backward compatibility).
 * @deprecated Use initiatePredictionDeposit + completePredictionDeposit instead
 */
export async function depositToPredictions(
  agentId: string,
  usdcAmount: number,
  solanaSignature: string
): Promise<DepositResult> {
  // Convert USDC to USD cents (1:1 for simplicity, could add conversion rate later)
  const usdCents = Math.floor(usdcAmount * 100);

  logger.info("Processing prediction deposit (legacy)", {
    agentId,
    usdcAmount,
    usdCents,
    solanaSignature,
  });

  // Check if this signature was already used
  const existingDeposit = await db.predictionDeposit.findUnique({
    where: { solanaSignature },
  });

  if (existingDeposit) {
    throw new Error("This transaction signature has already been used for a deposit");
  }

  // Get or create prediction balance
  const predictionBalance = await getOrCreatePredictionBalance(agentId);

  // Create deposit record and update balance in a transaction
  const result = await db.$transaction(async (tx) => {
    // Create deposit record
    const deposit = await tx.predictionDeposit.create({
      data: {
        agentId,
        predictionBalanceId: predictionBalance.id,
        usdcAmount,
        usdCents,
        solanaSignature,
        status: "confirmed",
        confirmedAt: new Date(),
      },
    });

    // Update balance
    await tx.predictionBalance.update({
      where: { id: predictionBalance.id },
      data: { balance: { increment: usdCents } },
    });

    return deposit;
  });

  // Audit log
  await createAuditLog({
    agentId,
    action: "prediction_deposit",
    asset: "usdc",
    amount: usdcAmount,
    signature: solanaSignature,
    status: "confirmed",
    metadata: { depositId: result.id, usdCents },
  });

  logger.info("Prediction deposit completed", {
    agentId,
    depositId: result.id,
    usdCents,
  });

  return {
    depositId: result.id,
    usdcAmount,
    usdCents,
    status: "confirmed",
  };
}

/**
 * Withdraw from prediction balance back to USDC in agent's wallet.
 * Transfers USDC from admin wallet to agent wallet.
 *
 * @param agentId Agent ID
 * @param agentWalletAddress Agent's Solana wallet address (destination)
 * @param usdCents Amount to withdraw in USD cents
 */
export async function withdrawFromPredictions(
  agentId: string,
  usdCents: number,
  agentWalletAddress?: string
): Promise<WithdrawResult> {
  if (!isAdminWalletConfigured()) {
    throw new Error("Prediction markets withdrawal is not configured");
  }

  logger.info("Processing prediction withdrawal", { agentId, usdCents });

  // Get prediction balance
  const predictionBalance = await getOrCreatePredictionBalance(agentId);

  if (predictionBalance.balance < usdCents) {
    throw new Error(
      `Insufficient prediction balance. Have $${(predictionBalance.balance / 100).toFixed(2)}, ` +
        `need $${(usdCents / 100).toFixed(2)}`
    );
  }

  // Convert to USDC (1:1)
  const usdcAmount = usdCents / 100;

  // Create withdrawal record and debit balance in a transaction FIRST
  // This ensures the balance is debited even if the transfer fails
  const withdrawal = await db.$transaction(async (tx) => {
    // Debit balance first
    await tx.predictionBalance.update({
      where: { id: predictionBalance.id },
      data: { balance: { decrement: usdCents } },
    });

    // Create withdrawal record (processing)
    const w = await tx.predictionWithdrawal.create({
      data: {
        agentId,
        predictionBalanceId: predictionBalance.id,
        usdCents,
        usdcAmount,
        status: "processing",
      },
    });

    return w;
  });

  // If no wallet address provided, just create a pending withdrawal
  // (for backward compatibility or manual processing)
  if (!agentWalletAddress) {
    await db.predictionWithdrawal.update({
      where: { id: withdrawal.id },
      data: { status: "pending" },
    });

    await createAuditLog({
      agentId,
      action: "prediction_withdrawal_request",
      asset: "usd",
      amount: usdCents / 100,
      status: "pending",
      metadata: { withdrawalId: withdrawal.id, usdCents, usdcAmount },
    });

    return {
      withdrawalId: withdrawal.id,
      usdCents,
      usdcAmount,
      status: "pending",
    };
  }

  // Transfer USDC from admin wallet to agent wallet
  let signature: string;
  try {
    signature = await transferUSDCFromAdmin(agentWalletAddress, usdcAmount);

    // Update withdrawal record with signature
    await db.predictionWithdrawal.update({
      where: { id: withdrawal.id },
      data: {
        status: "confirmed",
        solanaSignature: signature,
        processedAt: new Date(),
      },
    });
  } catch (error) {
    // If transfer fails, mark withdrawal as failed and refund balance
    await db.$transaction(async (tx) => {
      await tx.predictionWithdrawal.update({
        where: { id: withdrawal.id },
        data: { status: "failed" },
      });

      // Refund the balance
      await tx.predictionBalance.update({
        where: { id: predictionBalance.id },
        data: { balance: { increment: usdCents } },
      });
    });

    await createAuditLog({
      agentId,
      action: "prediction_withdrawal",
      asset: "usdc",
      amount: usdcAmount,
      to: agentWalletAddress,
      status: "failed",
      metadata: {
        withdrawalId: withdrawal.id,
        usdCents,
        error: String(error),
      },
    });

    throw new Error(`Withdrawal failed: ${error}. Balance has been refunded.`);
  }

  // Audit log for successful withdrawal
  await createAuditLog({
    agentId,
    action: "prediction_withdrawal",
    asset: "usdc",
    amount: usdcAmount,
    from: config.KNOT_KALSHI_ADMIN_WALLET_ADDRESS,
    to: agentWalletAddress,
    signature,
    status: "confirmed",
    metadata: { withdrawalId: withdrawal.id, usdCents },
  });

  logger.info("Prediction withdrawal completed", {
    agentId,
    withdrawalId: withdrawal.id,
    usdCents,
    signature,
  });

  return {
    withdrawalId: withdrawal.id,
    usdCents,
    usdcAmount,
    status: "confirmed",
  };
}

/**
 * Internal: Transfer USDC from admin wallet to agent wallet
 */
async function transferUSDCFromAdmin(
  toAddress: string,
  amount: number
): Promise<string> {
  const adminAddress = config.KNOT_KALSHI_ADMIN_WALLET_ADDRESS;

  const fromPubkey = new PublicKey(adminAddress);
  const toPubkey = new PublicKey(toAddress);

  // Get mint info for decimals
  const mintInfo = await getMint(connection, USDC_MINT);
  const decimals = mintInfo.decimals;
  const rawAmount = Math.floor(amount * Math.pow(10, decimals));

  // Get token accounts
  const fromTokenAccount = await getAssociatedTokenAddress(
    USDC_MINT,
    fromPubkey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const toTokenAccount = await getAssociatedTokenAddress(
    USDC_MINT,
    toPubkey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // Verify admin wallet has sufficient balance
  try {
    const fromAccountInfo = await getAccount(connection, fromTokenAccount, undefined, TOKEN_PROGRAM_ID);
    if (Number(fromAccountInfo.amount) < rawAmount) {
      throw new Error(
        `Admin wallet has insufficient USDC. This is a system error - please contact support.`
      );
    }
  } catch (error) {
    if ((error as Error).name === "TokenAccountNotFoundError") {
      throw new Error(`Admin wallet has no USDC. This is a system error - please contact support.`);
    }
    throw error;
  }

  const { blockhash } = await connection.getLatestBlockhash();
  const instructions = [];

  // Create recipient token account if needed
  const toAccountInfo = await connection.getAccountInfo(toTokenAccount);
  if (!toAccountInfo) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        fromPubkey, // payer (admin pays for account creation)
        toTokenAccount,
        toPubkey,
        USDC_MINT,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  // Transfer USDC
  instructions.push(
    createTransferCheckedInstruction(
      fromTokenAccount,
      USDC_MINT,
      toTokenAccount,
      fromPubkey,
      rawAmount,
      decimals,
      [],
      TOKEN_PROGRAM_ID
    )
  );

  const message = new TransactionMessage({
    payerKey: fromPubkey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const transaction = new VersionedTransaction(message);

  // Sign and broadcast using admin wallet in parent org
  const signature = await signAndBroadcastAdmin(transaction, adminAddress);

  logger.info("USDC transfer from admin completed", { signature, amount, toAddress });

  return signature;
}

// =============================================================================
// Trading
// =============================================================================

/**
 * Buy prediction contracts (market order).
 * Transfers USDC from agent wallet to admin wallet, then executes buy on Kalshi.
 *
 * @param agentId Agent ID
 * @param ticker Market ticker
 * @param side "yes" or "no"
 * @param count Number of contracts to buy
 * @param agentWalletAddress Agent's Solana wallet address
 * @param subOrgId Agent's Turnkey sub-org ID for signing
 */
export async function buyPrediction(
  agentId: string,
  ticker: string,
  side: "yes" | "no",
  count: number,
  agentWalletAddress: string,
  subOrgId: string
): Promise<BuyResult> {
  if (!isAdminWalletConfigured()) {
    throw new Error("Prediction markets are not configured");
  }

  logger.info("Processing prediction buy", { agentId, ticker, side, count });

  // Get market to determine current price
  const market = await kalshiRequest<{ market: KalshiMarket }>(
    "GET",
    `/markets/${ticker}`
  );

  // For market orders, use the ask price (what we'll pay)
  const pricePerContract = side === "yes" ? market.market.yes_ask : market.market.no_ask;

  if (!pricePerContract || pricePerContract <= 0) {
    throw new Error(`No ask price available for ${side} side of market ${ticker}`);
  }

  // Calculate costs (1% + $0.10 flat fee)
  const baseCost = pricePerContract * count; // Cost in cents
  const percentageFee = Math.ceil(baseCost * FEE_PERCENTAGE);
  const feeCents = percentageFee + FLAT_FEE_CENTS;
  const totalCost = baseCost + feeCents;
  const totalCostUSDC = totalCost / 100; // Convert cents to USDC

  // Get or create prediction balance (for tracking)
  const predictionBalance = await getOrCreatePredictionBalance(agentId);

  // Step 1: Transfer USDC from agent wallet to admin wallet
  let depositSignature: string;
  try {
    depositSignature = await transferUSDCToAdmin(
      agentWalletAddress,
      config.KNOT_KALSHI_ADMIN_WALLET_ADDRESS,
      totalCostUSDC,
      subOrgId
    );
    logger.info("USDC transferred to admin for prediction buy", {
      agentId,
      amount: totalCostUSDC,
      signature: depositSignature,
    });
  } catch (error) {
    logger.error("Failed to transfer USDC for prediction buy", { error });
    throw new Error(`Failed to transfer USDC: ${error}`);
  }

  // Step 2: Place order on Kalshi
  // Kalshi requires yes_price even for market orders
  // For "no" side, convert to yes_price (100 - no_price)
  const yesPrice = side === "yes" ? pricePerContract : 100 - pricePerContract;

  const orderRequest: CreateOrderRequest = {
    ticker,
    action: "buy",
    side,
    type: "market",
    count,
    yes_price: yesPrice,
  };

  let kalshiOrderId: string | undefined;
  let kalshiFillPrice: number | undefined;

  try {
    const response = await kalshiRequest<CreateOrderResponse>(
      "POST",
      "/portfolio/orders",
      orderRequest
    );
    kalshiOrderId = response.order.order_id;
    kalshiFillPrice = response.order.yes_price;
    logger.info("Kalshi order placed", { orderId: kalshiOrderId });
  } catch (error) {
    // Kalshi order failed - refund the FULL amount (fee is only kept on successful buy + later cancellation)
    logger.error("Kalshi order failed, refunding full USDC amount", { error });
    try {
      await transferUSDCFromAdmin(agentWalletAddress, totalCostUSDC);
      logger.info("Refunded full USDC after failed Kalshi order", { refundAmount: totalCostUSDC });
    } catch (refundError) {
      logger.error("Failed to refund USDC", { refundError });
      // Log for manual intervention - critical issue
      await createAuditLog({
        agentId,
        action: "prediction_buy_refund_failed",
        asset: "usdc",
        amount: totalCostUSDC,
        to: agentWalletAddress,
        status: "failed",
        metadata: {
          originalError: String(error),
          refundError: String(refundError),
          ticker,
          side,
          count,
        },
      });
    }
    throw new Error(`Failed to place order on Kalshi: ${error}`);
  }

  // Step 3: Update database in a transaction
  const result = await db.$transaction(async (tx) => {
    // Create deposit record (for tracking)
    await tx.predictionDeposit.create({
      data: {
        agentId,
        predictionBalanceId: predictionBalance.id,
        usdcAmount: totalCostUSDC,
        usdCents: totalCost,
        solanaSignature: depositSignature,
        status: "confirmed",
        confirmedAt: new Date(),
      },
    });

    // Create order record
    const order = await tx.predictionOrder.create({
      data: {
        agentId,
        predictionBalanceId: predictionBalance.id,
        ticker,
        eventTicker: market.market.event_ticker,
        side,
        action: "buy",
        count,
        pricePerContract,
        totalCost,
        feeCents,
        kalshiOrderId,
        kalshiFillPrice,
        status: "filled",
        filledAt: new Date(),
      },
    });

    // Update or create position
    const existingPosition = await tx.predictionPosition.findUnique({
      where: {
        agentId_ticker_side: { agentId, ticker, side },
      },
    });

    if (existingPosition) {
      // Update existing position (average cost)
      const newQuantity = existingPosition.quantity + count;
      const newTotalCost = existingPosition.totalCost + baseCost;
      const newAverageCost = Math.floor(newTotalCost / newQuantity);

      await tx.predictionPosition.update({
        where: { id: existingPosition.id },
        data: {
          quantity: newQuantity,
          totalCost: newTotalCost,
          averageCost: newAverageCost,
        },
      });
    } else {
      // Create new position
      await tx.predictionPosition.create({
        data: {
          agentId,
          predictionBalanceId: predictionBalance.id,
          ticker,
          eventTicker: market.market.event_ticker,
          side,
          quantity: count,
          averageCost: pricePerContract,
          totalCost: baseCost,
        },
      });
    }

    return { order };
  });

  // Audit log
  await createAuditLog({
    agentId,
    action: "prediction_buy",
    asset: ticker,
    amount: count,
    status: "confirmed",
    metadata: {
      orderId: result.order.id,
      kalshiOrderId,
      ticker,
      side,
      pricePerContract,
      totalCost,
      feeCents,
    },
  });

  logger.info("Prediction buy completed", {
    agentId,
    orderId: result.order.id,
    ticker,
    side,
    count,
  });

  return {
    orderId: result.order.id,
    ticker,
    side,
    count,
    pricePerContract,
    totalCost,
    feeCents,
    newBalance: 0, // Not tracking prediction balance - USDC flows directly
  };
}

/**
 * Sell prediction contracts (market order).
 * Executes sell on Kalshi, then transfers net proceeds (minus exit fee) to agent wallet.
 *
 * @param agentId Agent ID
 * @param ticker Market ticker
 * @param side "yes" or "no"
 * @param count Number of contracts to sell
 * @param agentWalletAddress Agent's Solana wallet address (destination for proceeds)
 */
export async function sellPrediction(
  agentId: string,
  ticker: string,
  side: "yes" | "no",
  count: number,
  agentWalletAddress: string
): Promise<SellResult> {
  if (!isAdminWalletConfigured()) {
    throw new Error("Prediction markets are not configured");
  }

  logger.info("Processing prediction sell", { agentId, ticker, side, count });

  // Check if agent has the position
  const position = await db.predictionPosition.findUnique({
    where: {
      agentId_ticker_side: { agentId, ticker, side },
    },
  });

  if (!position || position.quantity < count) {
    throw new Error(
      `Insufficient position. Have ${position?.quantity || 0} ${side} contracts, ` +
        `trying to sell ${count}`
    );
  }

  // Get market to determine current price
  const market = await kalshiRequest<{ market: KalshiMarket }>(
    "GET",
    `/markets/${ticker}`
  );

  // For market sell orders, use the bid price (what we'll receive)
  const pricePerContract = side === "yes" ? market.market.yes_bid : market.market.no_bid;

  if (!pricePerContract || pricePerContract <= 0) {
    throw new Error(`No bid price available for ${side} side of market ${ticker}`);
  }

  // Calculate proceeds (1% + $0.10 flat fee deducted)
  const grossProceeds = pricePerContract * count; // In cents
  const percentageFee = Math.ceil(grossProceeds * FEE_PERCENTAGE);
  const feeCents = percentageFee + FLAT_FEE_CENTS;
  const netProceeds = grossProceeds - feeCents;
  const netProceedsUSDC = netProceeds / 100; // Convert cents to USDC

  // Step 1: Place sell order on Kalshi
  // Kalshi requires yes_price even for market orders
  // For "no" side, convert to yes_price (100 - no_price)
  const yesPrice = side === "yes" ? pricePerContract : 100 - pricePerContract;

  const orderRequest: CreateOrderRequest = {
    ticker,
    action: "sell",
    side,
    type: "market",
    count,
    yes_price: yesPrice,
  };

  let kalshiOrderId: string | undefined;
  let kalshiFillPrice: number | undefined;

  try {
    const response = await kalshiRequest<CreateOrderResponse>(
      "POST",
      "/portfolio/orders",
      orderRequest
    );
    kalshiOrderId = response.order.order_id;
    kalshiFillPrice = response.order.yes_price;
    logger.info("Kalshi sell order placed", { orderId: kalshiOrderId });
  } catch (error) {
    logger.error("Failed to place Kalshi sell order", { error });
    throw new Error(`Failed to place sell order on Kalshi: ${error}`);
  }

  // Step 2: Transfer net proceeds from admin wallet to agent wallet
  let withdrawalSignature: string;
  try {
    withdrawalSignature = await transferUSDCFromAdmin(agentWalletAddress, netProceedsUSDC);
    logger.info("Proceeds transferred to agent", {
      agentId,
      amount: netProceedsUSDC,
      signature: withdrawalSignature,
    });
  } catch (error) {
    logger.error("Failed to transfer proceeds to agent", { error });
    // Note: The Kalshi sell already happened, so we need to track this for manual resolution
    // Create a failed withdrawal record
    await createAuditLog({
      agentId,
      action: "prediction_sell_withdrawal_failed",
      asset: "usdc",
      amount: netProceedsUSDC,
      to: agentWalletAddress,
      status: "failed",
      metadata: {
        kalshiOrderId,
        ticker,
        side,
        count,
        grossProceeds,
        netProceeds,
        feeCents,
        error: String(error),
      },
    });
    throw new Error(
      `Sell order succeeded but failed to transfer proceeds: ${error}. ` +
      `Please contact support with order ID: ${kalshiOrderId}`
    );
  }

  // Get prediction balance (for tracking purposes)
  const predictionBalance = await getOrCreatePredictionBalance(agentId);

  // Step 3: Update database in a transaction
  const result = await db.$transaction(async (tx) => {
    // Create order record
    const order = await tx.predictionOrder.create({
      data: {
        agentId,
        predictionBalanceId: predictionBalance.id,
        ticker,
        eventTicker: market.market.event_ticker,
        side,
        action: "sell",
        count,
        pricePerContract,
        totalCost: -netProceeds, // Negative because it's a credit/proceeds
        feeCents,
        kalshiOrderId,
        kalshiFillPrice,
        status: "filled",
        filledAt: new Date(),
      },
    });

    // Create withdrawal record for the proceeds
    await tx.predictionWithdrawal.create({
      data: {
        agentId,
        predictionBalanceId: predictionBalance.id,
        usdCents: netProceeds,
        usdcAmount: netProceedsUSDC,
        solanaSignature: withdrawalSignature,
        status: "confirmed",
        processedAt: new Date(),
      },
    });

    // Update position
    const newQuantity = position.quantity - count;
    const costReduction = Math.floor((position.totalCost * count) / position.quantity);

    if (newQuantity === 0) {
      // Delete position if fully sold
      await tx.predictionPosition.delete({
        where: { id: position.id },
      });
    } else {
      // Update position
      await tx.predictionPosition.update({
        where: { id: position.id },
        data: {
          quantity: newQuantity,
          totalCost: position.totalCost - costReduction,
        },
      });
    }

    return { order };
  });

  // Audit log
  await createAuditLog({
    agentId,
    action: "prediction_sell",
    asset: ticker,
    amount: count,
    status: "confirmed",
    metadata: {
      orderId: result.order.id,
      kalshiOrderId,
      ticker,
      side,
      pricePerContract,
      grossProceeds,
      netProceeds,
      feeCents,
      withdrawalSignature,
    },
  });

  logger.info("Prediction sell completed", {
    agentId,
    orderId: result.order.id,
    ticker,
    side,
    count,
    netProceedsUSDC,
  });

  return {
    orderId: result.order.id,
    ticker,
    side,
    count,
    pricePerContract,
    totalProceeds: netProceeds,
    feeCents,
    newBalance: 0, // Not tracking prediction balance - USDC flows directly
  };
}

// =============================================================================
// Position Tracking
// =============================================================================

/**
 * Get agent's prediction positions.
 */
export async function getAgentPositions(
  agentId: string,
  options?: { settled?: boolean }
): Promise<AgentPosition[]> {
  const { settled } = options || {};

  const positions = await db.predictionPosition.findMany({
    where: {
      agentId,
      ...(settled !== undefined ? { settled } : {}),
    },
    orderBy: { updatedAt: "desc" },
  });

  // Fetch current prices for open positions
  const positionsWithPrices: AgentPosition[] = [];

  for (const pos of positions) {
    let currentPrice: number | null = null;
    let currentValue: number | null = null;
    let unrealizedPnl: number | null = null;

    if (!pos.settled) {
      try {
        const market = await kalshiRequest<{ market: KalshiMarket }>(
          "GET",
          `/markets/${pos.ticker}`
        );
        currentPrice =
          pos.side === "yes" ? market.market.yes_bid : market.market.no_bid;
        if (currentPrice) {
          currentValue = currentPrice * pos.quantity;
          unrealizedPnl = currentValue - pos.totalCost;
        }
      } catch {
        // Market may be closed/settled, skip price fetch
      }
    }

    positionsWithPrices.push({
      ticker: pos.ticker,
      eventTicker: pos.eventTicker,
      side: pos.side as "yes" | "no",
      quantity: pos.quantity,
      averageCost: pos.averageCost,
      totalCost: pos.totalCost,
      currentPrice,
      currentValue,
      unrealizedPnl,
      settled: pos.settled,
      settlementResult: pos.settlementResult,
      settlementPayout: pos.settlementPayout,
    });
  }

  return positionsWithPrices;
}

/**
 * Get agent's order history.
 */
export async function getAgentOrders(
  agentId: string,
  options?: { ticker?: string; limit?: number }
) {
  const { ticker, limit = 50 } = options || {};

  const orders = await db.predictionOrder.findMany({
    where: {
      agentId,
      ...(ticker ? { ticker } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return orders.map((o) => ({
    orderId: o.id,
    ticker: o.ticker,
    eventTicker: o.eventTicker,
    side: o.side,
    action: o.action,
    count: o.count,
    pricePerContract: o.pricePerContract,
    totalCost: o.totalCost,
    feeCents: o.feeCents,
    kalshiOrderId: o.kalshiOrderId,
    status: o.status,
    createdAt: o.createdAt.toISOString(),
    filledAt: o.filledAt?.toISOString(),
  }));
}

// =============================================================================
// Settlement
// =============================================================================

/**
 * Check and settle positions for a resolved market.
 * Called when we detect a market has settled on Kalshi.
 */
export async function settleMarket(
  ticker: string,
  result: "yes" | "no"
): Promise<{ settledCount: number; totalPayout: number }> {
  logger.info("Settling market positions", { ticker, result });

  // Find all unsettled positions for this market
  const positions = await db.predictionPosition.findMany({
    where: { ticker, settled: false },
  });

  let settledCount = 0;
  let totalPayout = 0;

  for (const position of positions) {
    const won = position.side === result;
    // If won, each contract pays out 100 cents ($1)
    // If lost, payout is 0
    const payout = won ? position.quantity * 100 : 0;

    // Update position and credit balance if won
    await db.$transaction(async (tx) => {
      // Mark position as settled
      await tx.predictionPosition.update({
        where: { id: position.id },
        data: {
          settled: true,
          settlementResult: won ? "won" : "lost",
          settlementPayout: payout,
          settledAt: new Date(),
        },
      });

      // Credit balance if won
      if (payout > 0) {
        await tx.predictionBalance.update({
          where: { id: position.predictionBalanceId },
          data: { balance: { increment: payout } },
        });
      }
    });

    // Audit log
    await createAuditLog({
      agentId: position.agentId,
      action: "prediction_settlement",
      asset: ticker,
      amount: payout / 100,
      status: "confirmed",
      metadata: {
        positionId: position.id,
        ticker,
        side: position.side,
        quantity: position.quantity,
        result,
        won,
        payout,
      },
    });

    settledCount++;
    totalPayout += payout;
  }

  logger.info("Market settlement completed", {
    ticker,
    result,
    settledCount,
    totalPayout,
  });

  return { settledCount, totalPayout };
}

/**
 * Check for settled markets and process them.
 * Should be called periodically (cron job or similar).
 */
export async function checkAndSettleMarkets(): Promise<void> {
  logger.info("Checking for settled markets");

  // Get all unique tickers with unsettled positions
  const unsettledPositions = await db.predictionPosition.findMany({
    where: { settled: false },
    select: { ticker: true },
    distinct: ["ticker"],
  });

  for (const { ticker } of unsettledPositions) {
    try {
      const market = await kalshiRequest<{ market: KalshiMarket }>(
        "GET",
        `/markets/${ticker}`
      );

      if (market.market.status === "settled" && market.market.result) {
        await settleMarket(ticker, market.market.result as "yes" | "no");
      }
    } catch (error) {
      logger.error("Failed to check market for settlement", { ticker, error });
    }
  }
}
