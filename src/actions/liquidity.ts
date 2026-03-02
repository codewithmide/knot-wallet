import { PublicKey, Keypair } from "@solana/web3.js";
import * as MeteoraModule from "@meteora-ag/dlmm";
import BN from "bn.js";
import { connection, signAndBroadcast } from "../turnkey/signer.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DLMM: any = (MeteoraModule as any).default;
const { StrategyType, autoFillYByStrategy } = MeteoraModule;
import { checkPolicy } from "../policy/engine.js";
import { logger } from "../utils/logger.js";
import { createAuditLog } from "../utils/audit.js";
import { resolveTokenMint } from "../utils/tokens.js";
import { getTokenPriceUsd, computeUsdValue } from "../utils/pricing.js";

// Meteora DLMM API for pool discovery
const METEORA_API = "https://dlmm-api.meteora.ag";

// ============================================================================
// Types
// ============================================================================

export interface PoolInfo {
  address: string;
  name: string;
  mintX: string;
  mintY: string;
  symbolX: string;
  symbolY: string;
  binStep: number;
  baseFeePercentage: string;
  liquidity: string;
  feeApr: string;
  apr: string;
  tradeVolume24h: string;
}

export interface PoolDetails extends PoolInfo {
  activeBinId: number;
  activePrice: string;
  reserveX: string;
  reserveY: string;
}

export interface UserPosition {
  publicKey: string;
  poolAddress: string;
  lowerBinId: number;
  upperBinId: number;
  totalXAmount: string;
  totalYAmount: string;
  positionBinData: Array<{
    binId: number;
    xAmount: string;
    yAmount: string;
  }>;
  feeX: string;
  feeY: string;
  rewardOne: string;
  rewardTwo: string;
}

export interface AddLiquidityResult {
  signature: string;
  explorerUrl: string;
  positionAddress: string;
  poolAddress: string;
  strategy: string;
  amountX: string;
  amountY: string;
}

export interface RemoveLiquidityResult {
  signature: string;
  explorerUrl: string;
  positionAddress: string;
  percentageRemoved: number;
  claimedFees: boolean;
  closedPosition: boolean;
}

export interface ClaimRewardsResult {
  signature: string;
  explorerUrl: string;
  positionAddress: string;
  feesClaimed: boolean;
}

// ============================================================================
// Pool Discovery
// ============================================================================

/**
 * List all available DLMM pools from Meteora API.
 * Supports filtering by token symbols.
 */
export async function listPools(options?: {
  tokenX?: string;
  tokenY?: string;
  limit?: number;
}): Promise<PoolInfo[]> {
  const { tokenX, tokenY, limit = 50 } = options || {};

  logger.info("Fetching DLMM pools from Meteora", { tokenX, tokenY, limit });

  try {
    // Use paginated endpoint to avoid OOM from fetching all 70k+ pools.
    // The API paginates by *groups* (token pair names), not individual pools.
    const searchTerm = [tokenX, tokenY].filter(Boolean).join("-") || undefined;
    const groupLimit = searchTerm ? 50 : Math.min(Math.ceil(limit / 2), 100);
    const params = new URLSearchParams({
      page: "0",
      limit: String(groupLimit),
    });
    if (searchTerm) params.set("search_term", searchTerm);

    const response = await fetch(`${METEORA_API}/pair/all_by_groups?${params}`);

    if (!response.ok) {
      throw new Error(`Meteora API error: ${response.status}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: { groups: { name: string; pairs: any[] }[]; total: number } = await response.json();

    // Flatten groups into a single pool list
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let pools: any[] = data.groups.flatMap((g) => g.pairs);

    // Sort by liquidity (descending) and slice to the requested limit
    pools = pools
      .sort((a, b) => parseFloat(b.liquidity || "0") - parseFloat(a.liquidity || "0"))
      .slice(0, limit);

    return pools.map((p) => ({
      address: p.address,
      name: p.name,
      mintX: p.mint_x,
      mintY: p.mint_y,
      symbolX: p.name.split("-")[0] || "Unknown",
      symbolY: p.name.split("-")[1] || "Unknown",
      binStep: p.bin_step,
      baseFeePercentage: p.base_fee_percentage,
      liquidity: p.liquidity || "0",
      feeApr: p.fee_apr || "0",
      apr: p.apr || "0",
      tradeVolume24h: p.trade_volume_24h || "0",
    }));
  } catch (error) {
    logger.error("Failed to fetch pools from Meteora", { error: String(error) });
    throw new Error(`Failed to fetch pools: ${error}`);
  }
}

/**
 * Get detailed information about a specific DLMM pool.
 */
export async function getPoolInfo(poolAddress: string): Promise<PoolDetails> {
  logger.info("Fetching pool details", { poolAddress });

  try {
    // Fetch from Meteora API
    const response = await fetch(`${METEORA_API}/pair/${poolAddress}`);

    if (!response.ok) {
      throw new Error(`Pool not found: ${poolAddress}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pool: any = await response.json();

    // Also get on-chain data for active bin
    const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
    const activeBin = await dlmmPool.getActiveBin();

    return {
      address: pool.address,
      name: pool.name,
      mintX: pool.mint_x,
      mintY: pool.mint_y,
      symbolX: pool.name.split("-")[0] || "Unknown",
      symbolY: pool.name.split("-")[1] || "Unknown",
      binStep: pool.bin_step,
      baseFeePercentage: pool.base_fee_percentage,
      liquidity: pool.liquidity || "0",
      feeApr: pool.fee_apr || "0",
      apr: pool.apr || "0",
      tradeVolume24h: pool.trade_volume_24h || "0",
      activeBinId: activeBin.binId,
      activePrice: activeBin.price,
      reserveX: pool.reserve_x || "0",
      reserveY: pool.reserve_y || "0",
    };
  } catch (error) {
    logger.error("Failed to get pool info", { poolAddress, error: String(error) });
    throw new Error(`Failed to get pool info: ${error}`);
  }
}

// ============================================================================
// Position Management
// ============================================================================

/**
 * Get all user positions for a specific pool or all pools.
 */
export async function getUserPositions(
  userAddress: string,
  poolAddress?: string
): Promise<UserPosition[]> {
  logger.info("Fetching user positions", { userAddress, poolAddress });

  try {
    const userPubkey = new PublicKey(userAddress);

    if (poolAddress) {
      // Get positions for specific pool
      const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(userPubkey);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return userPositions.map((pos: any) => formatPosition(pos, poolAddress));
    }

    // Get positions across top pools the user may have interacted with
    // Use paginated endpoint to avoid OOM from fetching all 70k+ pools
    const poolsResponse = await fetch(`${METEORA_API}/pair/all_by_groups?page=0&limit=50`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const poolsData: { groups: { name: string; pairs: any[] }[]; total: number } = await poolsResponse.json();

    const positions: UserPosition[] = [];

    // Check top 50 pool groups by liquidity for user positions
    // This is a limitation - for a full solution, we'd need indexer support
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const topPools: any[] = poolsData.groups
      .flatMap((g) => g.pairs)
      .sort((a, b) => parseFloat(b.liquidity || "0") - parseFloat(a.liquidity || "0"))
      .slice(0, 50);

    for (const pool of topPools) {
      try {
        const dlmmPool = await DLMM.create(connection, new PublicKey(pool.address));
        const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(userPubkey);

        if (userPositions.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          positions.push(...userPositions.map((pos: any) => formatPosition(pos, pool.address)));
        }
      } catch {
        // Skip pools that fail
        continue;
      }
    }

    return positions;
  } catch (error) {
    logger.error("Failed to get user positions", { userAddress, error: String(error) });
    throw new Error(`Failed to get user positions: ${error}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatPosition(pos: any, poolAddress: string): UserPosition {
  return {
    publicKey: pos.publicKey.toString(),
    poolAddress,
    lowerBinId: pos.positionData.lowerBinId,
    upperBinId: pos.positionData.upperBinId,
    totalXAmount: pos.positionData.totalXAmount?.toString() || "0",
    totalYAmount: pos.positionData.totalYAmount?.toString() || "0",
    positionBinData: pos.positionBinData?.map((bin: { binId: number; positionXAmount: BN; positionYAmount: BN }) => ({
      binId: bin.binId,
      xAmount: bin.positionXAmount?.toString() || "0",
      yAmount: bin.positionYAmount?.toString() || "0",
    })) || [],
    feeX: pos.positionData.feeX?.toString() || "0",
    feeY: pos.positionData.feeY?.toString() || "0",
    rewardOne: pos.positionData.rewardOne?.toString() || "0",
    rewardTwo: pos.positionData.rewardTwo?.toString() || "0",
  };
}

// ============================================================================
// Liquidity Operations
// ============================================================================

/**
 * Add liquidity to a DLMM pool using a strategy.
 *
 * @param poolAddress - The DLMM pool address
 * @param amountX - Amount of token X (in human units)
 * @param amountY - Amount of token Y (in human units, or auto-calculated if not provided)
 * @param strategy - Distribution strategy: "spot" (uniform), "curve" (concentrated), "bidAsk" (asymmetric)
 * @param rangeWidth - Number of bins on each side of active bin (default: 10)
 */
export async function addLiquidity(
  agentAddress: string,
  agentId: string,
  subOrgId: string,
  poolAddress: string,
  amountX: number,
  amountY?: number,
  strategy: "spot" | "curve" | "bidAsk" = "spot",
  rangeWidth: number = 10
): Promise<AddLiquidityResult> {
  logger.info("Adding liquidity to DLMM pool", {
    poolAddress,
    amountX,
    amountY,
    strategy,
    rangeWidth,
  });

  try {
    const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
    const activeBin = await dlmmPool.getActiveBin();

    // Calculate bin range
    const minBinId = activeBin.binId - rangeWidth;
    const maxBinId = activeBin.binId + rangeWidth;

    // Get token info
    const tokenXInfo = await dlmmPool.tokenX;
    const tokenYInfo = await dlmmPool.tokenY;
    const decimalsX = tokenXInfo.decimal;
    const decimalsY = tokenYInfo.decimal;
    const mintX = tokenXInfo.publicKey.toString();
    const mintY = tokenYInfo.publicKey.toString();

    // Calculate USD value for policy check
    const [priceX, priceY] = await Promise.all([
      getTokenPriceUsd(mintX),
      getTokenPriceUsd(mintY),
    ]);

    const usdValueX = computeUsdValue(amountX, priceX) ?? 0;
    const usdValueY = computeUsdValue(amountY ?? 0, priceY) ?? 0;
    const totalUsdValue = usdValueX + usdValueY;

    if (totalUsdValue === 0) {
      throw new Error("Unable to determine USD value for liquidity operation. Price data unavailable.");
    }

    // Policy check BEFORE building transaction
    await checkPolicy(agentId, {
      type: "add_liquidity",
      usdValue: totalUsdValue,
      pool: poolAddress,
      amountX,
      amountY,
    });

    // Convert to lamports
    const totalXAmount = new BN(Math.floor(amountX * Math.pow(10, decimalsX)));

    // Auto-calculate Y amount if not provided
    let totalYAmount: BN;
    if (amountY !== undefined) {
      totalYAmount = new BN(Math.floor(amountY * Math.pow(10, decimalsY)));
    } else {
      // Use SDK helper to calculate Y based on strategy
      totalYAmount = autoFillYByStrategy(
        activeBin.binId,
        dlmmPool.lbPair.binStep,
        totalXAmount,
        new BN(activeBin.xAmount),
        new BN(activeBin.yAmount),
        minBinId,
        maxBinId,
        getStrategyType(strategy)
      );
    }

    // Generate a new position keypair
    const positionKeypair = Keypair.generate();

    // Create position and add liquidity
    const addLiquidityTx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: positionKeypair.publicKey,
      user: new PublicKey(agentAddress),
      totalXAmount,
      totalYAmount,
      strategy: {
        maxBinId,
        minBinId,
        strategyType: getStrategyType(strategy),
      },
    });

    // The position keypair needs to sign the transaction
    // First, add the position signature
    addLiquidityTx.partialSign(positionKeypair);

    // Then sign with user's key via Turnkey and broadcast
    const signature = await signAndBroadcast(addLiquidityTx, agentAddress, subOrgId);

    // Log to audit
    await createAuditLog({
      agentId,
      action: "add_liquidity",
      asset: `${tokenXInfo.mint.toString().slice(0, 8)}...`,
      amount: amountX,
      to: poolAddress,
      signature,
      status: "confirmed",
      metadata: {
        poolAddress,
        positionAddress: positionKeypair.publicKey.toString(),
        strategy,
        amountX,
        amountY: totalYAmount.toNumber() / Math.pow(10, decimalsY),
        minBinId,
        maxBinId,
        usdValue: totalUsdValue, // For daily limit calculation
      },
    });

    logger.info("Liquidity added successfully", { signature, positionAddress: positionKeypair.publicKey.toString() });

    return {
      signature,
      explorerUrl: `https://solscan.io/tx/${signature}`,
      positionAddress: positionKeypair.publicKey.toString(),
      poolAddress,
      strategy,
      amountX: `${amountX}`,
      amountY: `${totalYAmount.toNumber() / Math.pow(10, decimalsY)}`,
    };
  } catch (error) {
    logger.error("Failed to add liquidity", { poolAddress, error: String(error) });

    await createAuditLog({
      agentId,
      action: "add_liquidity",
      amount: amountX,
      to: poolAddress,
      status: "failed",
      metadata: { poolAddress, error: String(error) },
    });

    throw new Error(`Failed to add liquidity: ${error}`);
  }
}

/**
 * Remove liquidity from a DLMM position.
 *
 * @param positionAddress - The position public key
 * @param percentage - Percentage of liquidity to remove (1-100)
 * @param claimAndClose - Whether to claim fees and close position if fully withdrawn
 */
export async function removeLiquidity(
  agentAddress: string,
  agentId: string,
  subOrgId: string,
  poolAddress: string,
  positionAddress: string,
  percentage: number = 100,
  claimAndClose: boolean = true
): Promise<RemoveLiquidityResult> {
  logger.info("Removing liquidity from DLMM position", {
    positionAddress,
    percentage,
    claimAndClose,
  });

  if (percentage < 1 || percentage > 100) {
    throw new Error("Percentage must be between 1 and 100");
  }

  // Policy check (remove liquidity doesn't count against USD limits since it's inbound)
  await checkPolicy(agentId, {
    type: "remove_liquidity",
    usdValue: 0, // Not an outbound operation
    pool: poolAddress,
    position: positionAddress,
    percentage,
  });

  try {
    const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
    const positionPubkey = new PublicKey(positionAddress);

    // Get position info to determine bin range
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(
      new PublicKey(agentAddress)
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const position = userPositions.find(
      (p: any) => p.publicKey.toString() === positionAddress
    );

    if (!position) {
      throw new Error(`Position not found: ${positionAddress}`);
    }

    // Calculate basis points (percentage * 100)
    const bps = new BN(percentage * 100);

    // Remove liquidity
    const removeLiquidityTx = await dlmmPool.removeLiquidity({
      user: new PublicKey(agentAddress),
      position: positionPubkey,
      fromBinId: position.positionData.lowerBinId,
      toBinId: position.positionData.upperBinId,
      bps,
      shouldClaimAndClose: claimAndClose && percentage === 100,
    });

    // Handle if multiple transactions are returned
    const txs = Array.isArray(removeLiquidityTx) ? removeLiquidityTx : [removeLiquidityTx];

    let signature = "";
    for (const tx of txs) {
      signature = await signAndBroadcast(tx, agentAddress, subOrgId);
    }

    // Log to audit
    await createAuditLog({
      agentId,
      action: "remove_liquidity",
      to: poolAddress,
      signature,
      status: "confirmed",
      metadata: {
        poolAddress,
        positionAddress,
        percentage,
        claimedFees: claimAndClose && percentage === 100,
        closedPosition: claimAndClose && percentage === 100,
      },
    });

    logger.info("Liquidity removed successfully", { signature });

    return {
      signature,
      explorerUrl: `https://solscan.io/tx/${signature}`,
      positionAddress,
      percentageRemoved: percentage,
      claimedFees: claimAndClose && percentage === 100,
      closedPosition: claimAndClose && percentage === 100,
    };
  } catch (error) {
    logger.error("Failed to remove liquidity", { positionAddress, error: String(error) });

    await createAuditLog({
      agentId,
      action: "remove_liquidity",
      to: poolAddress,
      status: "failed",
      metadata: { poolAddress, positionAddress, error: String(error) },
    });

    throw new Error(`Failed to remove liquidity: ${error}`);
  }
}

/**
 * Claim fees and rewards from a DLMM position.
 */
export async function claimRewards(
  agentAddress: string,
  agentId: string,
  subOrgId: string,
  poolAddress: string,
  positionAddress: string
): Promise<ClaimRewardsResult> {
  logger.info("Claiming rewards from DLMM position", { positionAddress });

  try {
    const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
    const positionPubkey = new PublicKey(positionAddress);

    // Get position
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(
      new PublicKey(agentAddress)
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const position = userPositions.find(
      (p: any) => p.publicKey.toString() === positionAddress
    );

    if (!position) {
      throw new Error(`Position not found: ${positionAddress}`);
    }

    // Claim all rewards
    const claimTxs = await dlmmPool.claimAllRewards({
      owner: new PublicKey(agentAddress),
      positions: [position],
    });

    let signature = "";
    for (const tx of claimTxs) {
      signature = await signAndBroadcast(tx, agentAddress, subOrgId);
    }

    // Log to audit
    await createAuditLog({
      agentId,
      action: "claim_rewards",
      to: poolAddress,
      signature,
      status: "confirmed",
      metadata: {
        poolAddress,
        positionAddress,
        feeX: position.positionData.feeX?.toString() || "0",
        feeY: position.positionData.feeY?.toString() || "0",
      },
    });

    logger.info("Rewards claimed successfully", { signature });

    return {
      signature,
      explorerUrl: `https://solscan.io/tx/${signature}`,
      positionAddress,
      feesClaimed: true,
    };
  } catch (error) {
    logger.error("Failed to claim rewards", { positionAddress, error: String(error) });

    await createAuditLog({
      agentId,
      action: "claim_rewards",
      to: poolAddress,
      status: "failed",
      metadata: { poolAddress, positionAddress, error: String(error) },
    });

    throw new Error(`Failed to claim rewards: ${error}`);
  }
}

// ============================================================================
// Helpers
// ============================================================================

function getStrategyType(strategy: "spot" | "curve" | "bidAsk"): typeof StrategyType[keyof typeof StrategyType] {
  switch (strategy) {
    case "spot":
      return StrategyType.Spot;
    case "curve":
      return StrategyType.Curve;
    case "bidAsk":
      return StrategyType.BidAsk;
    default:
      return StrategyType.Spot;
  }
}
