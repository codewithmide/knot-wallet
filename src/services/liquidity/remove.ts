import { PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import BN from "bn.js";
import { connection, signAndBroadcastAdmin } from "../../turnkey/signer.js";
import { db } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";
import { createAuditLog } from "../../utils/audit.js";
import { getTokenPriceUsd, computeUsdValue } from "../../utils/pricing.js";
import { LiquidityError } from "../../utils/errors.js";
import { checkPolicy } from "../../policy/engine.js";
import { config } from "../../config.js";
import { DLMM } from "./meteora.js";
import { transferTokenFromAdmin } from "./transfers.js";
import { FEE_BPS, FLAT_FEE_USD, isMeteoraAdminConfigured } from "./types.js";
import type { RemoveLiquidityResult } from "./types.js";

/**
 * Remove liquidity from a position (custodial).
 * 1. Admin removes liquidity
 * 2. Deduct exit fee
 * 3. Transfer proceeds to agent
 */
export async function removeLiquidity(
  agentId: string,
  agentWalletAddress: string,
  positionId: string,
  percentage: number = 100
): Promise<RemoveLiquidityResult> {
  if (!isMeteoraAdminConfigured()) {
    throw new LiquidityError("Meteora liquidity provision is not configured");
  }

  if (percentage < 1 || percentage > 100) {
    throw new LiquidityError("Percentage must be between 1 and 100");
  }

  // Get position from database
  const position = await db.liquidityPosition.findUnique({
    where: { id: positionId },
  });

  if (!position) {
    throw new LiquidityError(`Position not found: ${positionId}`);
  }

  if (position.agentId !== agentId) {
    throw new LiquidityError("Position does not belong to this agent");
  }

  if (position.status !== "active") {
    throw new LiquidityError(`Position is not active: ${position.status}`);
  }

  logger.info("Removing liquidity (custodial)", {
    agentId, positionId, percentage,
  });

  // Policy check BEFORE any transaction is built or signed
  await checkPolicy(agentId, {
    type: "remove_liquidity",
    usdValue: 0,
    pool: position.poolAddress,
    position: positionId,
    percentage,
  });

  const adminAddress = config.KNOT_METEORA_ADMIN_WALLET_ADDRESS;

  // Get on-chain position info
  const dlmmPool = await DLMM.create(connection, new PublicKey(position.poolAddress));
  const positionPubkey = new PublicKey(position.positionPubkey);

  const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(
    new PublicKey(adminAddress)
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onChainPosition = userPositions.find(
    (p: any) => p.publicKey.toString() === position.positionPubkey
  );

  if (!onChainPosition) {
    throw new LiquidityError("Position not found on-chain");
  }

  // Calculate expected returns
  const totalXAmount = Number(onChainPosition.positionData.totalXAmount || 0);
  const totalYAmount = Number(onChainPosition.positionData.totalYAmount || 0);

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

  const expectedX = (totalXAmount * percentage / 100) / Math.pow(10, decimalsX);
  const expectedY = (totalYAmount * percentage / 100) / Math.pow(10, decimalsY);

  // Step 1: Admin removes liquidity
  const bps = new BN(percentage * 100);
  const shouldClose = percentage === 100;

  try {
    const removeLiquidityTx = await dlmmPool.removeLiquidity({
      user: new PublicKey(adminAddress),
      position: positionPubkey,
      fromBinId: position.minBinId,
      toBinId: position.maxBinId,
      bps,
      shouldClaimAndClose: shouldClose,
    });

    const txs = Array.isArray(removeLiquidityTx) ? removeLiquidityTx : [removeLiquidityTx];
    for (const tx of txs) {
      await signAndBroadcastAdmin(tx, adminAddress);
    }

    logger.info("Liquidity removed by admin", { positionId, percentage });
  } catch (error) {
    logger.error("Failed to remove liquidity", { error });
    throw new LiquidityError(`Failed to remove liquidity: ${error}`);
  }

  // Step 2: Calculate fee deductions
  const percentageFeeX = expectedX * (position.exitFeeBps / 10000);
  const percentageFeeY = expectedY * (position.exitFeeBps / 10000);
  const flatFeeY = FLAT_FEE_USD;
  const feeDeductedX = percentageFeeX;
  const feeDeductedY = percentageFeeY + flatFeeY;
  const netX = expectedX - feeDeductedX;
  const netY = Math.max(0, expectedY - feeDeductedY);

  // Step 3: Transfer proceeds to agent (minus fee)
  let withdrawalSignatureX: string | undefined;
  let withdrawalSignatureY: string | undefined;

  try {
    if (netX > 0) {
      withdrawalSignatureX = await transferTokenFromAdmin(position.mintX, agentWalletAddress, netX);
      logger.info("Token X transferred to agent", { signature: withdrawalSignatureX, amount: netX });

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
      logger.info("Token Y transferred to agent", { signature: withdrawalSignatureY, amount: netY });

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
    logger.error("Failed to transfer proceeds to agent", { error });
    await createAuditLog({
      agentId,
      action: "liquidity_remove_withdrawal_failed",
      asset: position.poolName || position.poolAddress,
      amount: netX,
      to: agentWalletAddress,
      status: "failed",
      metadata: {
        positionId,
        error: String(error),
        expectedX,
        expectedY,
        feeDeductedX,
        feeDeductedY,
      },
    });
    throw new LiquidityError(`Failed to transfer proceeds: ${error}`);
  }

  // Update position status
  if (shouldClose) {
    await db.liquidityPosition.update({
      where: { id: positionId },
      data: { status: "closed", closedAt: new Date() },
    });
  } else {
    await db.liquidityPosition.update({
      where: { id: positionId },
      data: {
        amountX: position.amountX * (1 - percentage / 100),
        amountY: position.amountY * (1 - percentage / 100),
      },
    });
  }

  // Calculate USD value for stats tracking
  const priceX = await getTokenPriceUsd(position.mintX);
  const priceY = await getTokenPriceUsd(position.mintY);
  const usdValueX = computeUsdValue(netX, priceX) || 0;
  const usdValueY = computeUsdValue(netY, priceY) || 0;
  const totalUsdValue = usdValueX + usdValueY;

  await createAuditLog({
    agentId,
    action: "remove_liquidity",
    asset: position.poolName || position.poolAddress,
    amount: expectedX,
    signature: withdrawalSignatureX,
    status: "confirmed",
    normalizedUsdAmount: totalUsdValue,
    metadata: {
      positionId,
      percentage,
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
    percentageRemoved: percentage,
    amountXReturned: netX,
    amountYReturned: netY,
    exitFeeBps: position.exitFeeBps,
    feeDeductedX,
    feeDeductedY,
    status: shouldClose ? "closed" : "partial",
  };
}
