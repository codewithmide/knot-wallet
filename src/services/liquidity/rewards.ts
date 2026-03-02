import { PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { connection, signAndBroadcastAdmin } from "../../turnkey/signer.js";
import { db } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";
import { createAuditLog } from "../../utils/audit.js";
import { getTokenPriceUsd, computeUsdValue } from "../../utils/pricing.js";
import { LiquidityError } from "../../utils/errors.js";
import { config } from "../../config.js";
import { DLMM } from "./meteora.js";
import { transferTokenFromAdmin } from "./transfers.js";
import { FEE_BPS, FLAT_FEE_USD, isMeteoraAdminConfigured } from "./types.js";
import type { ClaimRewardsResult } from "./types.js";

/**
 * Claim rewards from a position (custodial).
 * 1. Admin claims rewards
 * 2. Deduct platform fee
 * 3. Transfer to agent
 */
export async function claimRewards(
  agentId: string,
  agentWalletAddress: string,
  positionId: string
): Promise<ClaimRewardsResult> {
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

  if (position.status !== "active") {
    throw new LiquidityError(`Position is not active: ${position.status}`);
  }

  logger.info("Claiming rewards (custodial)", { agentId, positionId });

  const adminAddress = config.KNOT_METEORA_ADMIN_WALLET_ADDRESS;

  const dlmmPool = await DLMM.create(connection, new PublicKey(position.poolAddress));
  const tokenXInfo = await dlmmPool.tokenX;
  const tokenYInfo = await dlmmPool.tokenY;

  // Get decimals — fallback to on-chain lookup if SDK doesn't provide them
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

  // Get position rewards
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

  const feeX = Number(onChainPosition.positionData.feeX || 0) / Math.pow(10, decimalsX);
  const feeY = Number(onChainPosition.positionData.feeY || 0) / Math.pow(10, decimalsY);

  if (feeX === 0 && feeY === 0) {
    return {
      positionId,
      feeX: 0,
      feeY: 0,
      platformFeeX: 0,
      platformFeeY: 0,
      netFeeX: 0,
      netFeeY: 0,
      status: "no_rewards",
    };
  }

  // Step 1: Admin claims rewards
  try {
    const claimTxs = await dlmmPool.claimAllRewards({
      owner: new PublicKey(adminAddress),
      positions: [onChainPosition],
    });

    for (const tx of claimTxs) {
      await signAndBroadcastAdmin(tx, adminAddress);
    }

    logger.info("Rewards claimed by admin", { feeX, feeY });
  } catch (error) {
    logger.error("Failed to claim rewards", { error });
    throw new LiquidityError(`Failed to claim rewards: ${error}`);
  }

  // Step 2: Calculate platform fee (percentage + flat fee on Y token)
  const percentageFeeX = feeX * (FEE_BPS / 10000);
  const percentageFeeY = feeY * (FEE_BPS / 10000);
  const flatFeeY = FLAT_FEE_USD;
  const platformFeeX = percentageFeeX;
  const platformFeeY = percentageFeeY + flatFeeY;
  const netFeeX = feeX - platformFeeX;
  const netFeeY = Math.max(0, feeY - platformFeeY);

  // Step 3: Transfer to agent
  let signatureX: string | undefined;
  let signatureY: string | undefined;

  try {
    if (netFeeX > 0) {
      signatureX = await transferTokenFromAdmin(position.mintX, agentWalletAddress, netFeeX);
    }
    if (netFeeY > 0) {
      signatureY = await transferTokenFromAdmin(position.mintY, agentWalletAddress, netFeeY);
    }
  } catch (error) {
    logger.error("Failed to transfer rewards to agent", { error });
    await createAuditLog({
      agentId,
      action: "liquidity_claim_withdrawal_failed",
      asset: position.poolName || position.poolAddress,
      status: "failed",
      metadata: { positionId, error: String(error), feeX, feeY },
    });
    throw new LiquidityError(`Failed to transfer rewards: ${error}`);
  }

  // Record claim
  await db.liquidityRewardClaim.create({
    data: {
      agentId,
      positionId,
      poolAddress: position.poolAddress,
      feeX,
      feeY,
      platformFeeBps: FEE_BPS,
      platformFeeX,
      platformFeeY,
      solanaSignatureX: signatureX,
      solanaSignatureY: signatureY,
      status: "confirmed",
      processedAt: new Date(),
    },
  });

  // Calculate USD value for stats tracking
  const priceX = await getTokenPriceUsd(position.mintX);
  const priceY = await getTokenPriceUsd(position.mintY);
  const usdValueX = computeUsdValue(netFeeX, priceX) || 0;
  const usdValueY = computeUsdValue(netFeeY, priceY) || 0;
  const totalUsdValue = usdValueX + usdValueY;

  await createAuditLog({
    agentId,
    action: "claim_rewards",
    asset: position.poolName || position.poolAddress,
    amount: netFeeX + netFeeY,
    status: "confirmed",
    normalizedUsdAmount: totalUsdValue,
    metadata: { positionId, feeX, feeY, platformFeeX, platformFeeY, netFeeX, netFeeY, usdValueX, usdValueY },
  });

  return {
    positionId,
    feeX,
    feeY,
    platformFeeX,
    platformFeeY,
    netFeeX,
    netFeeY,
    status: "confirmed",
  };
}
