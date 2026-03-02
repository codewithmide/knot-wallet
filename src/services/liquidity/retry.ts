import { PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { connection } from "../../turnkey/signer.js";
import { db } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";
import { createAuditLog } from "../../utils/audit.js";
import { getTokenPriceUsd, computeUsdValue } from "../../utils/pricing.js";
import { LiquidityError } from "../../utils/errors.js";
import { config } from "../../config.js";
import { DLMM } from "./meteora.js";
import { transferTokenFromAdmin } from "./transfers.js";
import { FLAT_FEE_USD, isMeteoraAdminConfigured } from "./types.js";
import type { RemoveLiquidityResult } from "./types.js";

/**
 * Retry withdrawal for a position that was removed on-chain but transfer failed.
 * This handles cases where removeLiquidity succeeded on-chain but the transfer
 * to the agent failed (e.g., due to Token-2022 detection issues).
 */
export async function retryPendingWithdrawal(
  agentId: string,
  agentWalletAddress: string,
  positionId: string
): Promise<RemoveLiquidityResult> {
  if (!isMeteoraAdminConfigured()) {
    throw new LiquidityError("Meteora liquidity provision is not configured");
  }

  const position = await db.liquidityPosition.findUnique({
    where: { id: positionId },
  });

  if (!position) {
    throw new LiquidityError(`Position not found: ${positionId}`);
  }

  if (position.agentId !== agentId) {
    throw new LiquidityError("Position does not belong to this agent");
  }

  // This is specifically for positions that are marked active but not found on-chain
  if (position.status !== "active") {
    throw new LiquidityError(
      `Position status is "${position.status}". This function is only for active ` +
      `positions that were removed on-chain but transfer failed.`
    );
  }

  // Verify it's actually not on-chain
  const dlmmPool = await DLMM.create(connection, new PublicKey(position.poolAddress));
  const adminAddress = config.KNOT_METEORA_ADMIN_WALLET_ADDRESS;
  const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(
    new PublicKey(adminAddress)
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onChainPosition = userPositions.find(
    (p: any) => p.publicKey.toString() === position.positionPubkey
  );

  if (onChainPosition) {
    throw new LiquidityError(
      "Position still exists on-chain. Use the normal remove liquidity endpoint."
    );
  }

  logger.info("Retrying pending withdrawal for position removed on-chain", {
    positionId, agentId,
  });

  // Calculate expected proceeds based on entry amounts
  const expectedX = position.amountX;
  const expectedY = position.amountY;

  // Calculate fees (same as normal removal)
  const percentageFeeX = expectedX * (position.exitFeeBps / 10000);
  const percentageFeeY = expectedY * (position.exitFeeBps / 10000);
  const flatFeeY = FLAT_FEE_USD;
  const feeDeductedX = percentageFeeX;
  const feeDeductedY = percentageFeeY + flatFeeY;
  const netX = expectedX - feeDeductedX;
  const netY = Math.max(0, expectedY - feeDeductedY);

  // Get decimals for recording
  const tokenXInfo = await dlmmPool.tokenX;
  const tokenYInfo = await dlmmPool.tokenY;
  let decimalsX = tokenXInfo.decimal;
  let decimalsY = tokenYInfo.decimal;

  if (decimalsX === undefined || decimalsX === null) {
    const mintInfo = await getMint(connection, new PublicKey(position.mintX));
    decimalsX = mintInfo.decimals;
  }
  if (decimalsY === undefined || decimalsY === null) {
    const mintInfo = await getMint(connection, new PublicKey(position.mintY));
    decimalsY = mintInfo.decimals;
  }

  // Transfer proceeds from admin to agent
  let withdrawalSignatureX: string | undefined;
  let withdrawalSignatureY: string | undefined;

  try {
    if (netX > 0) {
      withdrawalSignatureX = await transferTokenFromAdmin(position.mintX, agentWalletAddress, netX);
      logger.info("Token X transferred to agent (retry)", {
        signature: withdrawalSignatureX, amount: netX,
      });

      await db.liquidityWithdrawal.create({
        data: {
          agentId,
          poolAddress: position.poolAddress,
          positionId,
          tokenMint: position.mintX,
          tokenSymbol: position.symbolX,
          amount: netX,
          amountRaw: Math.floor(netX * Math.pow(10, decimalsX)).toString(),
          feeBps: position.exitFeeBps,
          feeAmount: feeDeductedX,
          solanaSignature: withdrawalSignatureX,
          status: "confirmed",
          processedAt: new Date(),
        },
      });
    }

    if (netY > 0) {
      withdrawalSignatureY = await transferTokenFromAdmin(position.mintY, agentWalletAddress, netY);
      logger.info("Token Y transferred to agent (retry)", {
        signature: withdrawalSignatureY, amount: netY,
      });

      await db.liquidityWithdrawal.create({
        data: {
          agentId,
          poolAddress: position.poolAddress,
          positionId,
          tokenMint: position.mintY,
          tokenSymbol: position.symbolY,
          amount: netY,
          amountRaw: Math.floor(netY * Math.pow(10, decimalsY)).toString(),
          feeBps: position.exitFeeBps,
          feeAmount: feeDeductedY,
          solanaSignature: withdrawalSignatureY,
          status: "confirmed",
          processedAt: new Date(),
        },
      });
    }
  } catch (error) {
    logger.error("Failed to transfer proceeds to agent (retry)", { error });
    throw new LiquidityError(`Failed to transfer proceeds: ${error}`);
  }

  // Update position status to closed
  await db.liquidityPosition.update({
    where: { id: positionId },
    data: { status: "closed", closedAt: new Date() },
  });

  // Calculate USD value for stats tracking
  const priceX = await getTokenPriceUsd(position.mintX);
  const priceY = await getTokenPriceUsd(position.mintY);
  const usdValueX = computeUsdValue(netX, priceX) || 0;
  const usdValueY = computeUsdValue(netY, priceY) || 0;
  const totalUsdValue = usdValueX + usdValueY;

  await createAuditLog({
    agentId,
    action: "remove_liquidity_retry",
    asset: position.poolName || position.poolAddress,
    amount: netX || netY,
    status: "confirmed",
    normalizedUsdAmount: totalUsdValue,
    metadata: {
      positionId,
      expectedX,
      expectedY,
      feeDeductedX,
      feeDeductedY,
      netX,
      netY,
      usdValueX,
      usdValueY,
    },
  });

  return {
    positionId,
    poolAddress: position.poolAddress,
    percentageRemoved: 100,
    amountXReturned: netX,
    amountYReturned: netY,
    exitFeeBps: position.exitFeeBps,
    feeDeductedX,
    feeDeductedY,
    status: "closed",
  };
}
