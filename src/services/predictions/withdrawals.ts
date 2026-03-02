import { db } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";
import { createAuditLog } from "../../utils/audit.js";
import { checkPolicy } from "../../policy/engine.js";
import { config } from "../../config.js";
import { getOrCreatePredictionBalance, isAdminWalletConfigured } from "./balance.js";
import { transferUSDCFromAdmin } from "./transfers.js";
import type { WithdrawResult } from "./types.js";

// =============================================================================
// Withdrawals
// =============================================================================

/**
 * Withdraw from prediction balance back to USDC in agent's wallet.
 * Transfers USDC from admin wallet to agent wallet.
 *
 * @param agentId Agent ID
 * @param usdCents Amount to withdraw in USD cents
 * @param agentWalletAddress Agent's Solana wallet address (destination)
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

  // Policy check BEFORE any database transaction
  // Withdrawals count against daily USD limit
  await checkPolicy(agentId, {
    type: "prediction_market",
    usdValue: usdcAmount,
    action: "withdraw",
  });

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
    metadata: {
      withdrawalId: withdrawal.id,
      usdCents,
      usdValue: usdcAmount, // For daily limit calculation
    },
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
