import { db } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";
import { createAuditLog } from "../../utils/audit.js";
import { checkPolicy } from "../../policy/engine.js";
import {
  kalshiRequest,
  type CreateOrderRequest,
  type CreateOrderResponse,
  type KalshiMarket,
} from "../../kalshi/client.js";
import { config } from "../../config.js";
import { getOrCreatePredictionBalance, isAdminWalletConfigured } from "./balance.js";
import { transferUSDCToAdmin, transferUSDCFromAdmin } from "./transfers.js";
import { FEE_PERCENTAGE, FLAT_FEE_CENTS, type BuyResult, type SellResult } from "./types.js";

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

  // Policy check BEFORE any transaction
  await checkPolicy(agentId, {
    type: "prediction_market",
    usdValue: totalCostUSDC,
    ticker,
    side,
    orderAction: "buy",
    count,
    price: pricePerContract,
  });

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

  // Audit log - totalCost is in cents, convert to USD for stats
  const totalCostUsd = totalCost / 100;
  await createAuditLog({
    agentId,
    action: "prediction_buy",
    asset: ticker,
    amount: count,
    status: "confirmed",
    normalizedUsdAmount: totalCostUsd,
    metadata: {
      orderId: result.order.id,
      kalshiOrderId,
      ticker,
      side,
      pricePerContract,
      totalCost,
      feeCents,
      usdValue: totalCostUsd, // For daily limit calculation
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

  // Policy check (sell is inbound, doesn't count against USD limits)
  await checkPolicy(agentId, {
    type: "prediction_market",
    usdValue: 0, // Not an outbound operation
    ticker,
    side,
    orderAction: "sell",
    count,
    price: pricePerContract,
  });

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

  // Audit log - grossProceeds is in cents, convert to USD for stats
  const grossProceedsUsd = grossProceeds / 100;
  await createAuditLog({
    agentId,
    action: "prediction_sell",
    asset: ticker,
    amount: count,
    status: "confirmed",
    normalizedUsdAmount: grossProceedsUsd,
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
