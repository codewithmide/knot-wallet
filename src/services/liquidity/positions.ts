import { PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { connection } from "../../turnkey/signer.js";
import { db } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";
import { LiquidityError } from "../../utils/errors.js";
import { config } from "../../config.js";
import { DLMM } from "./meteora.js";
import type { AgentPosition, PositionDetails } from "./types.js";

/**
 * Get agent's liquidity positions (basic info from database).
 */
export async function getAgentPositions(
  agentId: string,
  options?: { status?: string }
): Promise<AgentPosition[]> {
  const { status } = options || {};

  const positions = await db.liquidityPosition.findMany({
    where: {
      agentId,
      ...(status ? { status } : {}),
    },
    orderBy: { createdAt: "desc" },
  });

  return positions.map((p) => ({
    id: p.id,
    poolAddress: p.poolAddress,
    poolName: p.poolName,
    positionPubkey: p.positionPubkey,
    strategy: p.strategy,
    amountX: p.amountX,
    amountY: p.amountY,
    symbolX: p.symbolX,
    symbolY: p.symbolY,
    status: p.status,
    createdAt: p.createdAt.toISOString(),
  }));
}

/**
 * Get detailed position info including on-chain data and pending rewards.
 * Use this to check if there are rewards to claim before calling claimRewards.
 */
export async function getPositionDetails(
  agentId: string,
  positionId: string
): Promise<PositionDetails> {
  const position = await db.liquidityPosition.findUnique({
    where: { id: positionId },
  });

  if (!position) {
    throw new LiquidityError(`Position not found: ${positionId}`);
  }

  if (position.agentId !== agentId) {
    throw new LiquidityError("Position does not belong to this agent");
  }

  // For closed positions, return database data only
  if (position.status !== "active") {
    return {
      id: position.id,
      poolAddress: position.poolAddress,
      poolName: position.poolName,
      positionPubkey: position.positionPubkey,
      strategy: position.strategy,
      symbolX: position.symbolX,
      symbolY: position.symbolY,
      status: position.status,
      createdAt: position.createdAt.toISOString(),
      currentAmountX: 0,
      currentAmountY: 0,
      pendingFeeX: 0,
      pendingFeeY: 0,
      hasRewardsToClaim: false,
      entryAmountX: position.amountX,
      entryAmountY: position.amountY,
    };
  }

  // Get on-chain position data
  const adminAddress = config.KNOT_METEORA_ADMIN_WALLET_ADDRESS;
  const dlmmPool = await DLMM.create(connection, new PublicKey(position.poolAddress));

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

  // Get on-chain position
  const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(
    new PublicKey(adminAddress)
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onChainPosition = userPositions.find(
    (p: any) => p.publicKey.toString() === position.positionPubkey
  );

  if (!onChainPosition) {
    // Position exists in DB but not on-chain (possibly already closed)
    logger.warn("Position not found on-chain — marking as closed in database", {
      positionId,
      positionPubkey: position.positionPubkey,
    });

    await db.liquidityPosition.update({
      where: { id: positionId },
      data: {
        status: "closed",
        closedAt: new Date(),
      },
    });

    return {
      id: position.id,
      poolAddress: position.poolAddress,
      poolName: position.poolName,
      positionPubkey: position.positionPubkey,
      strategy: position.strategy,
      symbolX: position.symbolX,
      symbolY: position.symbolY,
      status: "not_found_on_chain",
      createdAt: position.createdAt.toISOString(),
      currentAmountX: 0,
      currentAmountY: 0,
      pendingFeeX: 0,
      pendingFeeY: 0,
      hasRewardsToClaim: false,
      entryAmountX: position.amountX,
      entryAmountY: position.amountY,
    };
  }

  // Extract current amounts and pending fees
  const currentAmountX = Number(onChainPosition.positionData.totalXAmount || 0) / Math.pow(10, decimalsX);
  const currentAmountY = Number(onChainPosition.positionData.totalYAmount || 0) / Math.pow(10, decimalsY);
  const pendingFeeX = Number(onChainPosition.positionData.feeX || 0) / Math.pow(10, decimalsX);
  const pendingFeeY = Number(onChainPosition.positionData.feeY || 0) / Math.pow(10, decimalsY);

  return {
    id: position.id,
    poolAddress: position.poolAddress,
    poolName: position.poolName,
    positionPubkey: position.positionPubkey,
    strategy: position.strategy,
    symbolX: position.symbolX,
    symbolY: position.symbolY,
    status: position.status,
    createdAt: position.createdAt.toISOString(),
    currentAmountX,
    currentAmountY,
    pendingFeeX,
    pendingFeeY,
    hasRewardsToClaim: pendingFeeX > 0 || pendingFeeY > 0,
    entryAmountX: position.amountX,
    entryAmountY: position.amountY,
  };
}
