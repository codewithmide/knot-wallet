import { db } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";
import { createAuditLog } from "../../utils/audit.js";
import { config } from "../../config.js";
import { getOrCreatePredictionBalance, isAdminWalletConfigured } from "./balance.js";
import { transferUSDCToAdmin } from "./transfers.js";
import {
  DEPOSIT_EXPIRATION_MINUTES,
  type DepositInitiationResult,
  type DepositConfirmationResult,
  type DepositResult,
} from "./types.js";

// =============================================================================
// Deposits
// =============================================================================

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

  // Audit log - USDC amount is already in USD
  await createAuditLog({
    agentId,
    action: "prediction_deposit",
    asset: "usdc",
    amount: usdcAmount,
    from: agentWalletAddress,
    to: adminWalletAddress,
    signature,
    status: "confirmed",
    normalizedUsdAmount: usdcAmount,
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

  // Audit log - USDC amount is already in USD
  await createAuditLog({
    agentId,
    action: "prediction_deposit",
    asset: "usdc",
    amount: usdcAmount,
    signature: solanaSignature,
    status: "confirmed",
    normalizedUsdAmount: usdcAmount,
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
