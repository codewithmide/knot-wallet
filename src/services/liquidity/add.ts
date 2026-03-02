import { PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import BN from "bn.js";
import { connection, signAndBroadcastAdmin } from "../../turnkey/signer.js";
import { db } from "../../db/prisma.js";
import { logger } from "../../utils/logger.js";
import { createAuditLog } from "../../utils/audit.js";
import { getTokenPriceUsd, computeUsdValue } from "../../utils/pricing.js";
import { getTokenBalance } from "../../utils/balances.js";
import { LiquidityError } from "../../utils/errors.js";
import { checkPolicy } from "../../policy/engine.js";
import { config } from "../../config.js";
import { DLMM, autoFillYByStrategy, getStrategyType } from "./meteora.js";
import { getPoolInfo } from "./pools.js";
import { transferTokenToAdmin, transferTokenFromAdmin } from "./transfers.js";
import {
  FEE_BPS,
  FLAT_FEE_USD,
  MIN_POSITION_VALUE_USD,
  isMeteoraAdminConfigured,
} from "./types.js";
import type { AddLiquidityResult } from "./types.js";

/**
 * Add liquidity to a pool (custodial).
 * Supports both two-sided and one-sided liquidity:
 * - Two-sided: Provide both amountX and amountY (or just amountX, and Y is auto-calculated)
 * - One-sided X only: Set amountY = 0 (bins above active bin, selling X at higher prices)
 * - One-sided Y only: Set amountX = 0 (bins below active bin, buying X at lower prices)
 *
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
    throw new LiquidityError("Meteora liquidity provision is not configured");
  }

  // Validate: at least one token must have a positive amount
  if (amountX <= 0 && (amountY === undefined || amountY <= 0)) {
    throw new LiquidityError("At least one token amount must be positive");
  }

  // Determine liquidity type
  const isOneSidedX = amountX > 0 && amountY === 0;
  const isOneSidedY = amountX === 0 && amountY !== undefined && amountY > 0;
  const isOneSided = isOneSidedX || isOneSidedY;

  logger.info("Adding liquidity (custodial)", {
    agentId,
    poolAddress,
    amountX,
    amountY,
    strategy,
    liquidityType: isOneSidedX ? "one-sided-X" : isOneSidedY ? "one-sided-Y" : "two-sided",
  });

  // Get pool info from API first (provides string mint addresses)
  const poolInfo = await getPoolInfo(poolAddress);

  // Early balance check — fail fast before any on-chain calls
  const needsX = isOneSidedX || (!isOneSidedX && !isOneSidedY && amountX > 0);
  const needsY = isOneSidedY || (!isOneSidedX && !isOneSidedY && (amountY !== undefined && amountY > 0));

  if (needsX) {
    const balX = await getTokenBalance(agentWalletAddress, poolInfo.mintX);
    const availableX = balX?.balance ?? 0;
    if (availableX < amountX) {
      throw new LiquidityError(
        `Insufficient ${poolInfo.symbolX} balance. ` +
        `You have ${availableX} ${poolInfo.symbolX} but need ${amountX} ${poolInfo.symbolX}.`
      );
    }
  }

  if (needsY) {
    const balY = await getTokenBalance(agentWalletAddress, poolInfo.mintY);
    const availableY = balY?.balance ?? 0;
    if (availableY < amountY!) {
      throw new LiquidityError(
        `Insufficient ${poolInfo.symbolY} balance. ` +
        `You have ${availableY} ${poolInfo.symbolY} but need ${amountY} ${poolInfo.symbolY}.`
      );
    }
  }

  const poolName = poolInfo.name;
  const mintX = poolInfo.mintX;
  const mintY = poolInfo.mintY;
  const symbolX = poolInfo.symbolX;
  const symbolY = poolInfo.symbolY;

  // Get on-chain pool data
  const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
  const activeBin = await dlmmPool.getActiveBin();
  const tokenXInfo = dlmmPool.tokenX;
  const tokenYInfo = dlmmPool.tokenY;

  // Get decimals — fallback to on-chain lookup if SDK doesn't provide them
  let decimalsX = tokenXInfo.decimal;
  let decimalsY = tokenYInfo.decimal;

  if (decimalsX === undefined || decimalsX === null) {
    const mintInfo = await getMint(connection, new PublicKey(mintX));
    decimalsX = mintInfo.decimals;
    logger.info("Fetched decimalsX from on-chain", { mintX, decimalsX });
  }
  if (decimalsY === undefined || decimalsY === null) {
    const mintInfo = await getMint(connection, new PublicKey(mintY));
    decimalsY = mintInfo.decimals;
    logger.info("Fetched decimalsY from on-chain", { mintY, decimalsY });
  }

  logger.info("Token decimals", { decimalsX, decimalsY });

  // Calculate bin range based on liquidity type
  let minBinId: number;
  let maxBinId: number;

  if (isOneSidedX) {
    minBinId = activeBin.binId + 1;
    maxBinId = activeBin.binId + rangeWidth * 2;
    logger.info("One-sided X: bins above active bin", { minBinId, maxBinId, activeBinId: activeBin.binId });
  } else if (isOneSidedY) {
    minBinId = activeBin.binId - rangeWidth * 2;
    maxBinId = activeBin.binId - 1;
    logger.info("One-sided Y: bins below active bin", { minBinId, maxBinId, activeBinId: activeBin.binId });
  } else {
    minBinId = activeBin.binId - rangeWidth;
    maxBinId = activeBin.binId + rangeWidth;
  }

  // Calculate amounts
  let totalXAmount: BN;
  let totalYAmount: BN;

  if (isOneSidedX) {
    totalXAmount = new BN(Math.floor(amountX * Math.pow(10, decimalsX)));
    totalYAmount = new BN(0);
  } else if (isOneSidedY) {
    totalXAmount = new BN(0);
    totalYAmount = new BN(Math.floor(amountY! * Math.pow(10, decimalsY)));
  } else {
    totalXAmount = new BN(Math.floor(amountX * Math.pow(10, decimalsX)));
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
  }

  const actualAmountX = totalXAmount.toNumber() / Math.pow(10, decimalsX);
  const actualAmountY = totalYAmount.toNumber() / Math.pow(10, decimalsY);

  // Validate minimum position value ($1 USD)
  logger.info("Fetching token prices for validation", { mintX, mintY });
  const priceX = await getTokenPriceUsd(mintX);
  const priceY = await getTokenPriceUsd(mintY);
  logger.info("Token prices fetched", { priceX, priceY, actualAmountX, actualAmountY });

  const valueX = computeUsdValue(actualAmountX, priceX) ?? 0;
  const valueY = computeUsdValue(actualAmountY, priceY) ?? 0;
  const totalPositionValueUsd = valueX + valueY;

  const hasPriceData = priceX !== null || priceY !== null;

  if (hasPriceData && totalPositionValueUsd < MIN_POSITION_VALUE_USD) {
    throw new LiquidityError(
      `Position value too low. Minimum is $${MIN_POSITION_VALUE_USD} USD, ` +
      `but provided amounts are worth ~$${totalPositionValueUsd.toFixed(2)} USD. ` +
      `(${symbolX}: $${valueX.toFixed(2)}, ${symbolY}: $${valueY.toFixed(2)})`
    );
  }

  if (!hasPriceData) {
    logger.warn("Could not fetch token prices — skipping minimum value validation", {
      mintX, mintY, actualAmountX, actualAmountY,
    });
  }

  logger.info("Position value validated", {
    totalPositionValueUsd, valueX, valueY, minRequired: MIN_POSITION_VALUE_USD,
  });

  // Policy check BEFORE any transaction is built or signed
  await checkPolicy(agentId, {
    type: "add_liquidity",
    usdValue: totalPositionValueUsd,
    pool: poolAddress,
    amountX: actualAmountX,
    amountY: actualAmountY,
  });

  // Check admin wallet has sufficient SOL for position creation
  const adminPubkey = new PublicKey(config.KNOT_METEORA_ADMIN_WALLET_ADDRESS);
  const adminSolBalance = await connection.getBalance(adminPubkey);
  const POSITION_ACCOUNT_RENT = 10_000_000; // ~0.01 SOL
  const NETWORK_FEE_BUFFER = 10_000;
  const MIN_ADMIN_SOL_REQUIRED = POSITION_ACCOUNT_RENT + NETWORK_FEE_BUFFER;

  if (adminSolBalance < MIN_ADMIN_SOL_REQUIRED) {
    throw new LiquidityError(
      `Admin wallet has insufficient SOL to create position. ` +
      `Have ${(adminSolBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL, ` +
      `need at least ${(MIN_ADMIN_SOL_REQUIRED / LAMPORTS_PER_SOL).toFixed(4)} SOL ` +
      `for position account rent and fees. ` +
      `Please contact support to fund the admin wallet.`
    );
  }

  logger.info("Admin wallet SOL balance verified", {
    balance: adminSolBalance / LAMPORTS_PER_SOL,
    required: MIN_ADMIN_SOL_REQUIRED / LAMPORTS_PER_SOL,
  });

  // Step 1: Transfer tokens from agent to admin (skip zero amounts for one-sided)
  let depositSignatureX: string | undefined;
  let depositSignatureY: string | undefined;

  try {
    if (actualAmountX > 0) {
      const resultX = await transferTokenToAdmin(mintX, agentWalletAddress, actualAmountX, subOrgId);
      depositSignatureX = resultX.signature;
      logger.info("Token X transferred to admin", { signature: depositSignatureX, amount: actualAmountX });

      await db.liquidityDeposit.create({
        data: {
          agentId,
          poolAddress,
          tokenMint: mintX,
          tokenSymbol: symbolX,
          amount: actualAmountX,
          amountRaw: resultX.rawAmount,
          solanaSignature: depositSignatureX,
          status: "confirmed",
          confirmedAt: new Date(),
        },
      });
    } else {
      logger.info("Skipping token X transfer (one-sided Y position)", { amountX: actualAmountX });
    }

    if (actualAmountY > 0) {
      const resultY = await transferTokenToAdmin(mintY, agentWalletAddress, actualAmountY, subOrgId);
      depositSignatureY = resultY.signature;
      logger.info("Token Y transferred to admin", { signature: depositSignatureY, amount: actualAmountY });

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
    } else {
      logger.info("Skipping token Y transfer (one-sided X position)", { amountY: actualAmountY });
    }
  } catch (error) {
    logger.error("Failed to transfer tokens to admin", { error });
    throw new LiquidityError(`Failed to transfer tokens: ${error}`);
  }

  // Step 2: Calculate entry fee (1% + $0.10 flat fee)
  const isOneSidedXPosition = actualAmountX > 0 && actualAmountY === 0;

  const flatFeeInTokenX = priceX && priceX > 0 ? FLAT_FEE_USD / priceX : 0;
  const flatFeeInTokenY = priceY && priceY > 0 ? FLAT_FEE_USD / priceY : 0;

  const percentageFeeX = actualAmountX * (FEE_BPS / 10000);
  const percentageFeeY = actualAmountY * (FEE_BPS / 10000);

  const entryFeeX = isOneSidedXPosition ? percentageFeeX + flatFeeInTokenX : percentageFeeX;
  const entryFeeY = isOneSidedXPosition ? percentageFeeY : percentageFeeY + flatFeeInTokenY;

  const netAmountX = Math.max(0, actualAmountX - entryFeeX);
  const netAmountY = Math.max(0, actualAmountY - entryFeeY);

  const netTotalXAmount = new BN(Math.floor(netAmountX * Math.pow(10, decimalsX)));
  const netTotalYAmount = new BN(Math.floor(netAmountY * Math.pow(10, decimalsY)));

  logger.info("Entry fee calculated", {
    actualAmountX, actualAmountY,
    entryFeeX, entryFeeY,
    netAmountX, netAmountY,
  });

  // Step 3: Admin provides liquidity (net amount after fees)
  const adminAddress = config.KNOT_METEORA_ADMIN_WALLET_ADDRESS;
  const positionKeypair = Keypair.generate();

  try {
    const addLiquidityTx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: positionKeypair.publicKey,
      user: new PublicKey(adminAddress),
      totalXAmount: netTotalXAmount,
      totalYAmount: netTotalYAmount,
      strategy: {
        maxBinId,
        minBinId,
        strategyType: getStrategyType(strategy),
      },
    });

    addLiquidityTx.partialSign(positionKeypair);
    const signature = await signAndBroadcastAdmin(addLiquidityTx, adminAddress);
    logger.info("Liquidity added by admin", { signature, position: positionKeypair.publicKey.toString() });

    // Step 4: Record position in database
    const position = await db.liquidityPosition.create({
      data: {
        agentId,
        poolAddress,
        poolName,
        positionPubkey: positionKeypair.publicKey.toString(),
        strategy,
        minBinId,
        maxBinId,
        amountX: netAmountX,
        amountY: netAmountY,
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

    // Calculate USD values for stats tracking
    const usdValueX = computeUsdValue(actualAmountX, priceX) || 0;
    const usdValueY = computeUsdValue(actualAmountY, priceY) || 0;
    const totalUsdValue = usdValueX + usdValueY;

    const feeUsdValueX = computeUsdValue(entryFeeX, priceX) || 0;
    const feeUsdValueY = computeUsdValue(entryFeeY, priceY) || 0;
    const totalFeeUsd = feeUsdValueX + feeUsdValueY;
    const netUsdValue = totalUsdValue - totalFeeUsd;

    await createAuditLog({
      agentId,
      action: "add_liquidity",
      asset: poolName,
      amount: netAmountX || netAmountY,
      to: poolAddress,
      signature,
      status: "confirmed",
      normalizedUsdAmount: netUsdValue,
      metadata: {
        positionId: position.id,
        positionPubkey: positionKeypair.publicKey.toString(),
        poolAddress,
        strategy,
        depositedAmountX: actualAmountX,
        depositedAmountY: actualAmountY,
        entryFeeX,
        entryFeeY,
        entryFeeBps: FEE_BPS,
        flatFeeUsd: FLAT_FEE_USD,
        totalFeeUsd,
        netAmountX,
        netAmountY,
        netUsdValue,
        usdValueX,
        usdValueY,
        liquidityType: isOneSided ? (isOneSidedX ? "one-sided-X" : "one-sided-Y") : "two-sided",
      },
    });

    return {
      positionId: position.id,
      poolAddress,
      positionPubkey: positionKeypair.publicKey.toString(),
      strategy,
      depositedAmountX: actualAmountX,
      depositedAmountY: actualAmountY,
      entryFeeX,
      entryFeeY,
      netAmountX,
      netAmountY,
      entryFeeBps: FEE_BPS,
      flatFeeUsd: FLAT_FEE_USD,
      totalFeeUsd,
      status: "active",
    };
  } catch (error) {
    logger.error("Failed to add liquidity", { error });

    // Attempt to refund tokens to agent
    try {
      if (actualAmountX > 0) {
        await transferTokenFromAdmin(mintX, agentWalletAddress, actualAmountX);
      }
      if (actualAmountY > 0) {
        await transferTokenFromAdmin(mintY, agentWalletAddress, actualAmountY);
      }
      logger.info("Refunded tokens after failed liquidity add");
    } catch (refundError) {
      logger.error("Failed to refund tokens", { refundError });
      await createAuditLog({
        agentId,
        action: "liquidity_add_refund_failed",
        asset: poolName,
        amount: actualAmountX || actualAmountY,
        to: agentWalletAddress,
        status: "failed",
        metadata: {
          poolAddress,
          error: String(error),
          refundError: String(refundError),
        },
      });
    }

    throw new LiquidityError(`Failed to add liquidity: ${error}`);
  }
}
