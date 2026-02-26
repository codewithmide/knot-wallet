import { db } from "../db/prisma.js";
import { logger } from "../utils/logger.js";
import { createAuditLog } from "../utils/audit.js";
import { config } from "../config.js";
import { connection, signAndBroadcast } from "../turnkey/signer.js";
import {
  PublicKey,
  Keypair,
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
import * as MeteoraModule from "@meteora-ag/dlmm";
import BN from "bn.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DLMM: any = (MeteoraModule as any).default;
const { StrategyType, autoFillYByStrategy } = MeteoraModule;

// Fee percentage (1%)
const FEE_BPS = 100; // 1% = 100 basis points

// Flat fee per transaction ($0.10) - applied to Y token (quote/stablecoin)
// This covers Turnkey signing costs
const FLAT_FEE_USD = 0.10;

// Meteora DLMM API for pool discovery
const METEORA_API = "https://dlmm-api.meteora.ag";

// Native SOL mint (wrapped)
const NATIVE_SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

// =============================================================================
// Types
// =============================================================================

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

export interface AddLiquidityResult {
  positionId: string;
  poolAddress: string;
  positionPubkey: string;
  strategy: string;
  amountX: number;
  amountY: number;
  entryFeeBps: number;
  status: string;
}

export interface RemoveLiquidityResult {
  positionId: string;
  poolAddress: string;
  percentageRemoved: number;
  amountXReturned: number;
  amountYReturned: number;
  exitFeeBps: number;
  feeDeductedX: number;
  feeDeductedY: number;
  status: string;
}

export interface ClaimRewardsResult {
  positionId: string;
  feeX: number;
  feeY: number;
  platformFeeX: number;
  platformFeeY: number;
  netFeeX: number;
  netFeeY: number;
  status: string;
}

export interface AgentPosition {
  id: string;
  poolAddress: string;
  poolName: string | null;
  positionPubkey: string;
  strategy: string;
  amountX: number;
  amountY: number;
  symbolX: string | null;
  symbolY: string | null;
  status: string;
  createdAt: string;
}

// =============================================================================
// Configuration Check
// =============================================================================

/**
 * Check if Meteora admin wallet is configured
 */
export function isMeteoraAdminConfigured(): boolean {
  return !!(config.KNOT_METEORA_ADMIN_KEY_ID && config.KNOT_METEORA_ADMIN_WALLET_ADDRESS);
}

// =============================================================================
// Pool Discovery (Read-Only - No Admin Needed)
// =============================================================================

/**
 * List available DLMM pools from Meteora API.
 */
export async function listPools(options?: {
  tokenX?: string;
  tokenY?: string;
  limit?: number;
}): Promise<PoolInfo[]> {
  const { tokenX, tokenY, limit = 50 } = options || {};

  logger.info("Fetching DLMM pools from Meteora", { tokenX, tokenY, limit });

  const response = await fetch(`${METEORA_API}/pair/all`);
  if (!response.ok) {
    throw new Error(`Meteora API error: ${response.status}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pools: any[] = await response.json();

  // Filter by token if specified
  if (tokenX) {
    const upperX = tokenX.toUpperCase();
    pools = pools.filter(
      (p) => p.name.toUpperCase().includes(upperX)
    );
  }

  if (tokenY) {
    const upperY = tokenY.toUpperCase();
    pools = pools.filter(
      (p) => p.name.toUpperCase().includes(upperY)
    );
  }

  // Sort by liquidity and limit
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
}

/**
 * Get pool details
 */
export async function getPoolInfo(poolAddress: string) {
  const response = await fetch(`${METEORA_API}/pair/${poolAddress}`);
  if (!response.ok) {
    throw new Error(`Pool not found: ${poolAddress}`);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pool: any = await response.json();

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
  };
}

// =============================================================================
// Token Transfer Helpers
// =============================================================================

/**
 * Transfer SPL token from agent to admin wallet
 */
async function transferTokenToAdmin(
  tokenMint: string,
  fromAddress: string,
  amount: number,
  subOrgId: string
): Promise<{ signature: string; rawAmount: string }> {
  const mintPubkey = new PublicKey(tokenMint);
  const fromPubkey = new PublicKey(fromAddress);
  const adminPubkey = new PublicKey(config.KNOT_METEORA_ADMIN_WALLET_ADDRESS);

  const mintInfo = await getMint(connection, mintPubkey);
  const decimals = mintInfo.decimals;
  const rawAmount = Math.floor(amount * Math.pow(10, decimals));

  const fromTokenAccount = await getAssociatedTokenAddress(mintPubkey, fromPubkey);
  const toTokenAccount = await getAssociatedTokenAddress(mintPubkey, adminPubkey);

  // Verify balance
  try {
    const accountInfo = await getAccount(connection, fromTokenAccount);
    if (Number(accountInfo.amount) < rawAmount) {
      throw new Error(`Insufficient balance. Have ${Number(accountInfo.amount) / Math.pow(10, decimals)}, need ${amount}`);
    }
  } catch (error) {
    if ((error as Error).name === "TokenAccountNotFoundError") {
      throw new Error(`No token account found. Balance is 0.`);
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
        fromPubkey,
        toTokenAccount,
        adminPubkey,
        mintPubkey
      )
    );
  }

  instructions.push(
    createTransferCheckedInstruction(
      fromTokenAccount,
      mintPubkey,
      toTokenAccount,
      fromPubkey,
      rawAmount,
      decimals
    )
  );

  const message = new TransactionMessage({
    payerKey: fromPubkey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const transaction = new VersionedTransaction(message);
  const signature = await signAndBroadcast(transaction, fromAddress, subOrgId);

  return { signature, rawAmount: rawAmount.toString() };
}

/**
 * Transfer SPL token from admin to agent wallet
 */
async function transferTokenFromAdmin(
  tokenMint: string,
  toAddress: string,
  amount: number
): Promise<string> {
  const adminAddress = config.KNOT_METEORA_ADMIN_WALLET_ADDRESS;
  const adminSubOrgId = config.KNOT_METEORA_ADMIN_KEY_ID;

  const mintPubkey = new PublicKey(tokenMint);
  const fromPubkey = new PublicKey(adminAddress);
  const toPubkey = new PublicKey(toAddress);

  const mintInfo = await getMint(connection, mintPubkey);
  const decimals = mintInfo.decimals;
  const rawAmount = Math.floor(amount * Math.pow(10, decimals));

  const fromTokenAccount = await getAssociatedTokenAddress(mintPubkey, fromPubkey);
  const toTokenAccount = await getAssociatedTokenAddress(mintPubkey, toPubkey);

  const { blockhash } = await connection.getLatestBlockhash();
  const instructions = [];

  // Create recipient token account if needed
  const toAccountInfo = await connection.getAccountInfo(toTokenAccount);
  if (!toAccountInfo) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        fromPubkey,
        toTokenAccount,
        toPubkey,
        mintPubkey
      )
    );
  }

  instructions.push(
    createTransferCheckedInstruction(
      fromTokenAccount,
      mintPubkey,
      toTokenAccount,
      fromPubkey,
      rawAmount,
      decimals
    )
  );

  const message = new TransactionMessage({
    payerKey: fromPubkey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const transaction = new VersionedTransaction(message);
  const signature = await signAndBroadcast(transaction, adminAddress, adminSubOrgId);

  return signature;
}

// =============================================================================
// Liquidity Operations (Custodial)
// =============================================================================

/**
 * Add liquidity to a pool (custodial).
 * 1. Agent transfers tokens to admin wallet
 * 2. Admin provides liquidity
 * 3. Track position in database
 */
export async function addLiquidity(
  agentId: string,
  agentWalletAddress: string,
  subOrgId: string,
  poolAddress: string,
  amountX: number,
  amountY?: number,
  strategy: "spot" | "curve" | "bidAsk" = "spot",
  rangeWidth: number = 10
): Promise<AddLiquidityResult> {
  if (!isMeteoraAdminConfigured()) {
    throw new Error("Meteora liquidity provision is not configured");
  }

  logger.info("Adding liquidity (custodial)", {
    agentId,
    poolAddress,
    amountX,
    amountY,
    strategy,
  });

  // Get pool info
  const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
  const activeBin = await dlmmPool.getActiveBin();
  const tokenXInfo = await dlmmPool.tokenX;
  const tokenYInfo = await dlmmPool.tokenY;
  const decimalsX = tokenXInfo.decimal;
  const decimalsY = tokenYInfo.decimal;
  const mintX = tokenXInfo.mint.toString();
  const mintY = tokenYInfo.mint.toString();

  // Get pool name from API
  let poolName = "Unknown";
  try {
    const poolInfo = await getPoolInfo(poolAddress);
    poolName = poolInfo.name;
  } catch {
    // Use default
  }

  const symbolX = poolName.split("-")[0] || "TokenX";
  const symbolY = poolName.split("-")[1] || "TokenY";

  // Calculate amounts
  const totalXAmount = new BN(Math.floor(amountX * Math.pow(10, decimalsX)));
  const minBinId = activeBin.binId - rangeWidth;
  const maxBinId = activeBin.binId + rangeWidth;

  let totalYAmount: BN;
  if (amountY !== undefined) {
    totalYAmount = new BN(Math.floor(amountY * Math.pow(10, decimalsY)));
  } else {
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

  const actualAmountY = totalYAmount.toNumber() / Math.pow(10, decimalsY);

  // Step 1: Transfer tokens from agent to admin
  let depositSignatureX: string | undefined;
  let depositSignatureY: string | undefined;

  try {
    // Transfer token X
    const resultX = await transferTokenToAdmin(mintX, agentWalletAddress, amountX, subOrgId);
    depositSignatureX = resultX.signature;
    logger.info("Token X transferred to admin", { signature: depositSignatureX, amount: amountX });

    // Record deposit
    await db.liquidityDeposit.create({
      data: {
        agentId,
        poolAddress,
        tokenMint: mintX,
        tokenSymbol: symbolX,
        amount: amountX,
        amountRaw: resultX.rawAmount,
        solanaSignature: depositSignatureX,
        status: "confirmed",
        confirmedAt: new Date(),
      },
    });

    // Transfer token Y
    const resultY = await transferTokenToAdmin(mintY, agentWalletAddress, actualAmountY, subOrgId);
    depositSignatureY = resultY.signature;
    logger.info("Token Y transferred to admin", { signature: depositSignatureY, amount: actualAmountY });

    // Record deposit
    await db.liquidityDeposit.create({
      data: {
        agentId,
        poolAddress,
        tokenMint: mintY,
        tokenSymbol: symbolY,
        amount: actualAmountY,
        amountRaw: resultY.rawAmount,
        solanaSignature: depositSignatureY,
        status: "confirmed",
        confirmedAt: new Date(),
      },
    });
  } catch (error) {
    logger.error("Failed to transfer tokens to admin", { error });
    throw new Error(`Failed to transfer tokens: ${error}`);
  }

  // Step 2: Admin provides liquidity
  const adminAddress = config.KNOT_METEORA_ADMIN_WALLET_ADDRESS;
  const adminSubOrgId = config.KNOT_METEORA_ADMIN_KEY_ID;
  const positionKeypair = Keypair.generate();

  try {
    const addLiquidityTx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: positionKeypair.publicKey,
      user: new PublicKey(adminAddress),
      totalXAmount,
      totalYAmount,
      strategy: {
        maxBinId,
        minBinId,
        strategyType: getStrategyType(strategy),
      },
    });

    addLiquidityTx.partialSign(positionKeypair);
    const signature = await signAndBroadcast(addLiquidityTx, adminAddress, adminSubOrgId);
    logger.info("Liquidity added by admin", { signature, position: positionKeypair.publicKey.toString() });

    // Step 3: Record position in database
    const position = await db.liquidityPosition.create({
      data: {
        agentId,
        poolAddress,
        poolName,
        positionPubkey: positionKeypair.publicKey.toString(),
        strategy,
        minBinId,
        maxBinId,
        amountX,
        amountY: actualAmountY,
        mintX,
        mintY,
        symbolX,
        symbolY,
        entryFeeBps: FEE_BPS,
        exitFeeBps: FEE_BPS,
        status: "active",
        depositSignatureX,
        depositSignatureY,
      },
    });

    // Audit log
    await createAuditLog({
      agentId,
      action: "liquidity_add",
      asset: poolName,
      amount: amountX,
      to: poolAddress,
      signature,
      status: "confirmed",
      metadata: {
        positionId: position.id,
        positionPubkey: positionKeypair.publicKey.toString(),
        poolAddress,
        strategy,
        amountX,
        amountY: actualAmountY,
      },
    });

    return {
      positionId: position.id,
      poolAddress,
      positionPubkey: positionKeypair.publicKey.toString(),
      strategy,
      amountX,
      amountY: actualAmountY,
      entryFeeBps: FEE_BPS,
      status: "active",
    };
  } catch (error) {
    logger.error("Failed to add liquidity", { error });

    // Attempt to refund tokens to agent
    try {
      await transferTokenFromAdmin(mintX, agentWalletAddress, amountX);
      await transferTokenFromAdmin(mintY, agentWalletAddress, actualAmountY);
      logger.info("Refunded tokens after failed liquidity add");
    } catch (refundError) {
      logger.error("Failed to refund tokens", { refundError });
      await createAuditLog({
        agentId,
        action: "liquidity_add_refund_failed",
        asset: poolName,
        amount: amountX,
        to: agentWalletAddress,
        status: "failed",
        metadata: {
          poolAddress,
          error: String(error),
          refundError: String(refundError),
        },
      });
    }

    throw new Error(`Failed to add liquidity: ${error}`);
  }
}

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
    throw new Error("Meteora liquidity provision is not configured");
  }

  if (percentage < 1 || percentage > 100) {
    throw new Error("Percentage must be between 1 and 100");
  }

  // Get position from database
  const position = await db.liquidityPosition.findUnique({
    where: { id: positionId },
  });

  if (!position) {
    throw new Error(`Position not found: ${positionId}`);
  }

  if (position.agentId !== agentId) {
    throw new Error("Position does not belong to this agent");
  }

  if (position.status !== "active") {
    throw new Error(`Position is not active: ${position.status}`);
  }

  logger.info("Removing liquidity (custodial)", {
    agentId,
    positionId,
    percentage,
  });

  const adminAddress = config.KNOT_METEORA_ADMIN_WALLET_ADDRESS;
  const adminSubOrgId = config.KNOT_METEORA_ADMIN_KEY_ID;

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
    throw new Error("Position not found on-chain");
  }

  // Calculate expected returns
  const totalXAmount = Number(onChainPosition.positionData.totalXAmount || 0);
  const totalYAmount = Number(onChainPosition.positionData.totalYAmount || 0);

  const tokenXInfo = await dlmmPool.tokenX;
  const tokenYInfo = await dlmmPool.tokenY;
  const decimalsX = tokenXInfo.decimal;
  const decimalsY = tokenYInfo.decimal;

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
      await signAndBroadcast(tx, adminAddress, adminSubOrgId);
    }

    logger.info("Liquidity removed by admin", { positionId, percentage });
  } catch (error) {
    logger.error("Failed to remove liquidity", { error });
    throw new Error(`Failed to remove liquidity: ${error}`);
  }

  // Step 2: Calculate fee deductions (percentage fee + flat fee on Y token)
  const percentageFeeX = expectedX * (position.exitFeeBps / 10000);
  const percentageFeeY = expectedY * (position.exitFeeBps / 10000);
  // Apply flat fee to Y token (typically USDC/stablecoin quote)
  const flatFeeY = FLAT_FEE_USD;
  const feeDeductedX = percentageFeeX;
  const feeDeductedY = percentageFeeY + flatFeeY;
  const netX = expectedX - feeDeductedX;
  const netY = Math.max(0, expectedY - feeDeductedY); // Ensure non-negative

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
    throw new Error(`Failed to transfer proceeds: ${error}`);
  }

  // Update position status
  if (shouldClose) {
    await db.liquidityPosition.update({
      where: { id: positionId },
      data: { status: "closed", closedAt: new Date() },
    });
  } else {
    // Update amounts (partial withdrawal)
    await db.liquidityPosition.update({
      where: { id: positionId },
      data: {
        amountX: position.amountX * (1 - percentage / 100),
        amountY: position.amountY * (1 - percentage / 100),
      },
    });
  }

  // Audit log
  await createAuditLog({
    agentId,
    action: "liquidity_remove",
    asset: position.poolName || position.poolAddress,
    amount: expectedX,
    signature: withdrawalSignatureX,
    status: "confirmed",
    metadata: {
      positionId,
      percentage,
      expectedX,
      expectedY,
      feeDeductedX,
      feeDeductedY,
      netX,
      netY,
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
    throw new Error("Meteora liquidity provision is not configured");
  }

  const position = await db.liquidityPosition.findUnique({
    where: { id: positionId },
  });

  if (!position) {
    throw new Error(`Position not found: ${positionId}`);
  }

  if (position.agentId !== agentId) {
    throw new Error("Position does not belong to this agent");
  }

  if (position.status !== "active") {
    throw new Error(`Position is not active: ${position.status}`);
  }

  logger.info("Claiming rewards (custodial)", { agentId, positionId });

  const adminAddress = config.KNOT_METEORA_ADMIN_WALLET_ADDRESS;
  const adminSubOrgId = config.KNOT_METEORA_ADMIN_KEY_ID;

  const dlmmPool = await DLMM.create(connection, new PublicKey(position.poolAddress));
  const tokenXInfo = await dlmmPool.tokenX;
  const tokenYInfo = await dlmmPool.tokenY;
  const decimalsX = tokenXInfo.decimal;
  const decimalsY = tokenYInfo.decimal;

  // Get position rewards
  const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(
    new PublicKey(adminAddress)
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onChainPosition = userPositions.find(
    (p: any) => p.publicKey.toString() === position.positionPubkey
  );

  if (!onChainPosition) {
    throw new Error("Position not found on-chain");
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
      await signAndBroadcast(tx, adminAddress, adminSubOrgId);
    }

    logger.info("Rewards claimed by admin", { feeX, feeY });
  } catch (error) {
    logger.error("Failed to claim rewards", { error });
    throw new Error(`Failed to claim rewards: ${error}`);
  }

  // Step 2: Calculate platform fee (percentage fee + flat fee on Y token)
  const percentageFeeX = feeX * (FEE_BPS / 10000);
  const percentageFeeY = feeY * (FEE_BPS / 10000);
  // Apply flat fee to Y token (typically USDC/stablecoin quote)
  const flatFeeY = FLAT_FEE_USD;
  const platformFeeX = percentageFeeX;
  const platformFeeY = percentageFeeY + flatFeeY;
  const netFeeX = feeX - platformFeeX;
  const netFeeY = Math.max(0, feeY - platformFeeY); // Ensure non-negative

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
    throw new Error(`Failed to transfer rewards: ${error}`);
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

  // Audit log
  await createAuditLog({
    agentId,
    action: "liquidity_claim",
    asset: position.poolName || position.poolAddress,
    amount: netFeeX + netFeeY,
    status: "confirmed",
    metadata: { positionId, feeX, feeY, platformFeeX, platformFeeY, netFeeX, netFeeY },
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

// =============================================================================
// Position Queries
// =============================================================================

/**
 * Get agent's liquidity positions
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

// =============================================================================
// Helpers
// =============================================================================

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
