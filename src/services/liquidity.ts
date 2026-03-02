import { db } from "../db/prisma.js";
import { logger } from "../utils/logger.js";
import { createAuditLog } from "../utils/audit.js";
import { getTokenPriceUsd, computeUsdValue } from "../utils/pricing.js";
import { getTokenBalance } from "../utils/balances.js";
import { LiquidityError } from "../utils/errors.js";
import { checkPolicy } from "../policy/engine.js";
import { config } from "../config.js";
import { connection, signAndBroadcast, signAndBroadcastAdmin } from "../turnkey/signer.js";
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
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import { SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
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

// Minimum position value in USD
// Reject if total position value < $1 to avoid uneconomical positions
const MIN_POSITION_VALUE_USD = 1.0;

// Meteora DLMM API for pool discovery
const METEORA_API = "https://dlmm-api.meteora.ag";

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
  // Gross amounts deposited by agent
  depositedAmountX: number;
  depositedAmountY: number;
  // Entry fees (stay in admin wallet)
  entryFeeX: number;
  entryFeeY: number;
  // Net amounts actually provided as LP
  netAmountX: number;
  netAmountY: number;
  // Fee details
  entryFeeBps: number;
  flatFeeUsd: number;
  totalFeeUsd: number;
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
    throw new LiquidityError(`Meteora API error: ${response.status}`);
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
    throw new LiquidityError(`Pool not found: ${poolAddress}`);
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
 * Handles both standard Token Program and Token-2022
 * Special handling for native SOL: wraps to wSOL if needed
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

  // Check if this is wrapped SOL (native mint)
  const isNativeSol = mintPubkey.equals(NATIVE_MINT);

  // Detect which token program owns this mint
  // Try standard Token Program first, fallback to Token-2022 on ANY error
  let tokenProgramId = TOKEN_PROGRAM_ID;
  let mintInfo;
  try {
    mintInfo = await getMint(connection, mintPubkey, undefined, TOKEN_PROGRAM_ID);
  } catch (error) {
    // If standard program fails, try Token-2022
    logger.info("Standard Token Program failed, trying Token-2022", {
      mint: tokenMint,
      error: error instanceof Error ? error.message : String(error)
    });
    try {
      mintInfo = await getMint(connection, mintPubkey, undefined, TOKEN_2022_PROGRAM_ID);
      tokenProgramId = TOKEN_2022_PROGRAM_ID;
      logger.info("Token-2022 detected for mint", { mint: tokenMint });
    } catch (token2022Error) {
      // Both failed - throw original error
      logger.error("Both Token Program and Token-2022 failed", {
        mint: tokenMint,
        standardError: error instanceof Error ? error.message : String(error),
        token2022Error: token2022Error instanceof Error ? token2022Error.message : String(token2022Error),
      });
      throw error;
    }
  }

  const decimals = mintInfo.decimals;
  const rawAmount = Math.floor(amount * Math.pow(10, decimals));

  const fromTokenAccount = await getAssociatedTokenAddress(
    mintPubkey,
    fromPubkey,
    false,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const toTokenAccount = await getAssociatedTokenAddress(
    mintPubkey,
    adminPubkey,
    false,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const { blockhash } = await connection.getLatestBlockhash();
  const instructions = [];

  // Rent cost for creating a token account (~0.00204 SOL)
  const TOKEN_ACCOUNT_RENT = 2039280; // lamports

  // Check if admin's token account exists (needed for fee calculation)
  const adminAccountInfo = await connection.getAccountInfo(toTokenAccount);
  const needsAdminAccount = !adminAccountInfo;

  // Check if user has wSOL token account
  let needsWrapping = false;
  let needsUserAccount = false;

  try {
    const accountInfo = await getAccount(connection, fromTokenAccount, undefined, tokenProgramId);
    if (Number(accountInfo.amount) < rawAmount) {
      // Has wSOL account but not enough balance
      if (isNativeSol) {
        // Check if they have enough native SOL to top up
        const nativeBalance = await connection.getBalance(fromPubkey);
        const existingWsol = Number(accountInfo.amount);
        const neededNativeLamports = rawAmount - existingWsol;
        // Account for admin ATA creation if needed
        const rentForAdminAta = needsAdminAccount ? TOKEN_ACCOUNT_RENT : 0;
        const networkFee = 10000; // buffer for network fees
        const totalNeeded = neededNativeLamports + rentForAdminAta + networkFee;

        if (nativeBalance >= totalNeeded) {
          // They have enough native SOL - we'll wrap it
          needsWrapping = true;
          logger.info("Will wrap additional native SOL to wSOL", {
            existingWsol: existingWsol / LAMPORTS_PER_SOL,
            neededNative: neededNativeLamports / LAMPORTS_PER_SOL,
            rentForAdminAta: rentForAdminAta / LAMPORTS_PER_SOL,
          });
        } else {
          throw new LiquidityError(
            `Insufficient SOL balance. Have ${existingWsol / LAMPORTS_PER_SOL} wSOL + ${nativeBalance / LAMPORTS_PER_SOL} native SOL, ` +
            `need ${amount} SOL + ~${(rentForAdminAta + networkFee) / LAMPORTS_PER_SOL} SOL for fees.`
          );
        }
      } else {
        throw new LiquidityError(`Insufficient balance. Have ${Number(accountInfo.amount) / Math.pow(10, decimals)}, need ${amount}`);
      }
    }
  } catch (error) {
    if ((error as Error).name === "TokenAccountNotFoundError") {
      // No wSOL token account exists
      if (isNativeSol) {
        needsUserAccount = true;
        // Check if they have native SOL instead
        const nativeBalance = await connection.getBalance(fromPubkey);
        // Account for both user and admin ATA creation if needed
        const rentForUserAta = TOKEN_ACCOUNT_RENT;
        const rentForAdminAta = needsAdminAccount ? TOKEN_ACCOUNT_RENT : 0;
        const networkFee = 10000; // buffer for network fees
        const totalNeeded = rawAmount + rentForUserAta + rentForAdminAta + networkFee;

        if (nativeBalance >= totalNeeded) {
          // They have enough native SOL - we'll create wSOL account and wrap
          needsWrapping = true;
          logger.info("Will create wSOL account and wrap native SOL", {
            nativeBalance: nativeBalance / LAMPORTS_PER_SOL,
            amountToWrap: amount,
            rentForUserAta: rentForUserAta / LAMPORTS_PER_SOL,
            rentForAdminAta: rentForAdminAta / LAMPORTS_PER_SOL,
            totalNeeded: totalNeeded / LAMPORTS_PER_SOL,
          });

          // Create wSOL ATA for the user
          instructions.push(
            createAssociatedTokenAccountInstruction(
              fromPubkey,
              fromTokenAccount,
              fromPubkey,
              mintPubkey,
              tokenProgramId,
              ASSOCIATED_TOKEN_PROGRAM_ID
            )
          );
        } else {
          const neededSol = totalNeeded / LAMPORTS_PER_SOL;
          throw new LiquidityError(
            `Insufficient SOL balance. Have ${nativeBalance / LAMPORTS_PER_SOL} SOL, need ~${neededSol.toFixed(4)} SOL ` +
            `(${amount} SOL + ~${((rentForUserAta + rentForAdminAta + networkFee) / LAMPORTS_PER_SOL).toFixed(4)} SOL for account creation and fees).`
          );
        }
      } else {
        throw new LiquidityError(`No token account found. Balance is 0.`);
      }
    } else {
      throw error;
    }
  }

  // If we need to wrap native SOL, add wrapping instructions
  if (needsWrapping && isNativeSol) {
    // Transfer native SOL to the wSOL ATA
    instructions.push(
      SystemProgram.transfer({
        fromPubkey,
        toPubkey: fromTokenAccount,
        lamports: rawAmount,
      })
    );

    // Sync the native lamports to wSOL balance
    instructions.push(
      createSyncNativeInstruction(fromTokenAccount, tokenProgramId)
    );

    logger.info("Added SOL wrapping instructions", { amount, rawAmount });
  }

  // Create recipient token account if needed (we already checked this above)
  const toAccountInfo = adminAccountInfo;
  if (!toAccountInfo) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        fromPubkey,
        toTokenAccount,
        adminPubkey,
        mintPubkey,
        tokenProgramId,
        ASSOCIATED_TOKEN_PROGRAM_ID
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
      decimals,
      [],
      tokenProgramId
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
 * Handles both standard Token Program and Token-2022
 * Special handling for wSOL: automatically unwraps to native SOL
 */
async function transferTokenFromAdmin(
  tokenMint: string,
  toAddress: string,
  amount: number
): Promise<string> {
  const adminAddress = config.KNOT_METEORA_ADMIN_WALLET_ADDRESS;

  const mintPubkey = new PublicKey(tokenMint);
  const fromPubkey = new PublicKey(adminAddress);
  const toPubkey = new PublicKey(toAddress);

  // Check if this is wrapped SOL (native mint)
  const isNativeSol = mintPubkey.equals(NATIVE_MINT);

  // Detect which token program owns this mint
  // Try standard Token Program first, fallback to Token-2022 on ANY error
  let tokenProgramId = TOKEN_PROGRAM_ID;
  let mintInfo;
  try {
    mintInfo = await getMint(connection, mintPubkey, undefined, TOKEN_PROGRAM_ID);
  } catch (error) {
    // If standard program fails, try Token-2022
    logger.info("Standard Token Program failed, trying Token-2022", {
      mint: tokenMint,
      error: error instanceof Error ? error.message : String(error)
    });
    try {
      mintInfo = await getMint(connection, mintPubkey, undefined, TOKEN_2022_PROGRAM_ID);
      tokenProgramId = TOKEN_2022_PROGRAM_ID;
      logger.info("Token-2022 detected for mint", { mint: tokenMint });
    } catch (token2022Error) {
      // Both failed - throw original error
      logger.error("Both Token Program and Token-2022 failed", {
        mint: tokenMint,
        standardError: error instanceof Error ? error.message : String(error),
        token2022Error: token2022Error instanceof Error ? token2022Error.message : String(token2022Error),
      });
      throw error;
    }
  }

  const decimals = mintInfo.decimals;
  const rawAmount = Math.floor(amount * Math.pow(10, decimals));

  const fromTokenAccount = await getAssociatedTokenAddress(
    mintPubkey,
    fromPubkey,
    false,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const toTokenAccount = await getAssociatedTokenAddress(
    mintPubkey,
    toPubkey,
    false,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const { blockhash } = await connection.getLatestBlockhash();
  const instructions = [];

  // Special handling for wSOL: unwrap admin's wSOL and send native SOL directly
  if (isNativeSol) {
    logger.info("Unwrapping admin's wSOL and sending native SOL to agent", { amount });

    // Check if admin has a wSOL token account
    const fromAccountInfo = await connection.getAccountInfo(fromTokenAccount);

    if (fromAccountInfo) {
      // Admin has wSOL token account - close it to unwrap to native SOL
      // wSOL is ALWAYS standard Token Program, not Token-2022
      logger.info("Closing admin's wSOL account", { fromTokenAccount: fromTokenAccount.toString() });
      instructions.push(
        createCloseAccountInstruction(
          fromTokenAccount,
          fromPubkey,    // unwrapped SOL goes to admin's native wallet
          fromPubkey,    // admin is the owner
          [],
          TOKEN_PROGRAM_ID  // wSOL is always standard Token Program
        )
      );
    } else {
      // Admin doesn't have wSOL account - they already have native SOL
      logger.info("Admin doesn't have wSOL account - has native SOL already");
    }

    // Transfer native SOL from admin to agent
    instructions.push(
      SystemProgram.transfer({
        fromPubkey,
        toPubkey,
        lamports: rawAmount,
      })
    );
  } else {
    // For regular SPL tokens (not wSOL), do standard token transfer

    // Create recipient token account if needed
    const toAccountInfo = await connection.getAccountInfo(toTokenAccount);
    if (!toAccountInfo) {
      instructions.push(
        createAssociatedTokenAccountInstruction(
          fromPubkey,
          toTokenAccount,
          toPubkey,
          mintPubkey,
          tokenProgramId,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }

    // Transfer token from admin to agent
    instructions.push(
      createTransferCheckedInstruction(
        fromTokenAccount,
        mintPubkey,
        toTokenAccount,
        fromPubkey,
        rawAmount,
        decimals,
        [],
        tokenProgramId
      )
    );
  }

  const message = new TransactionMessage({
    payerKey: fromPubkey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const transaction = new VersionedTransaction(message);
  // Use parent org signing for admin wallet
  const signature = await signAndBroadcastAdmin(transaction, adminAddress);

  return signature;
}

// =============================================================================
// Liquidity Operations (Custodial)
// =============================================================================

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

  // Get decimals - fallback to on-chain lookup if SDK doesn't provide them
  let decimalsX = tokenXInfo.decimal;
  let decimalsY = tokenYInfo.decimal;

  // If decimals are missing, fetch from on-chain mint
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
    // One-sided X: bins ABOVE active bin (selling X at higher prices)
    // Active bin is excluded, start from activeBin + 1
    minBinId = activeBin.binId + 1;
    maxBinId = activeBin.binId + rangeWidth * 2;
    logger.info("One-sided X: bins above active bin", { minBinId, maxBinId, activeBinId: activeBin.binId });
  } else if (isOneSidedY) {
    // One-sided Y: bins BELOW active bin (buying X at lower prices)
    // Active bin is excluded, end at activeBin - 1
    minBinId = activeBin.binId - rangeWidth * 2;
    maxBinId = activeBin.binId - 1;
    logger.info("One-sided Y: bins below active bin", { minBinId, maxBinId, activeBinId: activeBin.binId });
  } else {
    // Two-sided: bins around active bin
    minBinId = activeBin.binId - rangeWidth;
    maxBinId = activeBin.binId + rangeWidth;
  }

  // Calculate amounts
  let totalXAmount: BN;
  let totalYAmount: BN;

  if (isOneSidedX) {
    // One-sided X: only X, no Y
    totalXAmount = new BN(Math.floor(amountX * Math.pow(10, decimalsX)));
    totalYAmount = new BN(0);
  } else if (isOneSidedY) {
    // One-sided Y: only Y, no X
    totalXAmount = new BN(0);
    totalYAmount = new BN(Math.floor(amountY! * Math.pow(10, decimalsY)));
  } else {
    // Two-sided
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
  // Only enforce if we can successfully fetch prices
  logger.info("Fetching token prices for validation", { mintX, mintY });
  const priceX = await getTokenPriceUsd(mintX);
  const priceY = await getTokenPriceUsd(mintY);
  logger.info("Token prices fetched", { priceX, priceY, actualAmountX, actualAmountY });

  const valueX = computeUsdValue(actualAmountX, priceX) ?? 0;
  const valueY = computeUsdValue(actualAmountY, priceY) ?? 0;
  const totalPositionValueUsd = valueX + valueY;

  // Only validate if we have at least one valid price
  const hasPriceData = priceX !== null || priceY !== null;

  if (hasPriceData && totalPositionValueUsd < MIN_POSITION_VALUE_USD) {
    throw new LiquidityError(
      `Position value too low. Minimum is $${MIN_POSITION_VALUE_USD} USD, ` +
      `but provided amounts are worth ~$${totalPositionValueUsd.toFixed(2)} USD. ` +
      `(${symbolX}: $${valueX.toFixed(2)}, ${symbolY}: $${valueY.toFixed(2)})`
    );
  }

  if (!hasPriceData) {
    logger.warn("Could not fetch token prices - skipping minimum value validation", {
      mintX,
      mintY,
      actualAmountX,
      actualAmountY
    });
  }

  logger.info("Position value validated", {
    totalPositionValueUsd,
    valueX,
    valueY,
    minRequired: MIN_POSITION_VALUE_USD,
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
  // Meteora position accounts require ~0.01 SOL rent (rent-exempt)
  const adminPubkey = new PublicKey(config.KNOT_METEORA_ADMIN_WALLET_ADDRESS);
  const adminSolBalance = await connection.getBalance(adminPubkey);
  const POSITION_ACCOUNT_RENT = 10_000_000; // ~0.01 SOL (conservative estimate)
  const NETWORK_FEE_BUFFER = 10_000; // buffer for transaction fees
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
    // Transfer token X (skip if zero for one-sided Y)
    if (actualAmountX > 0) {
      const resultX = await transferTokenToAdmin(mintX, agentWalletAddress, actualAmountX, subOrgId);
      depositSignatureX = resultX.signature;
      logger.info("Token X transferred to admin", { signature: depositSignatureX, amount: actualAmountX });

      // Record deposit
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

    // Transfer token Y (skip if zero for one-sided X)
    if (actualAmountY > 0) {
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
    } else {
      logger.info("Skipping token Y transfer (one-sided X position)", { amountY: actualAmountY });
    }
  } catch (error) {
    logger.error("Failed to transfer tokens to admin", { error });
    throw new LiquidityError(`Failed to transfer tokens: ${error}`);
  }

  // Step 2: Calculate entry fee (1% + $0.10 flat fee)
  // Fee stays in admin wallet - we just provide less liquidity
  // Flat fee applied to Y token (quote), or X token for one-sided X positions
  const isOneSidedXPosition = actualAmountX > 0 && actualAmountY === 0;

  // Convert $0.10 flat fee to token amount (based on which token gets the flat fee)
  // priceX and priceY were already fetched earlier for position value validation
  const flatFeeInTokenX = priceX && priceX > 0 ? FLAT_FEE_USD / priceX : 0;
  const flatFeeInTokenY = priceY && priceY > 0 ? FLAT_FEE_USD / priceY : 0;

  // Apply percentage fee to both tokens
  const percentageFeeX = actualAmountX * (FEE_BPS / 10000);
  const percentageFeeY = actualAmountY * (FEE_BPS / 10000);

  // Apply flat fee to appropriate token (Y for two-sided/one-sided-Y, X for one-sided-X)
  const entryFeeX = isOneSidedXPosition ? percentageFeeX + flatFeeInTokenX : percentageFeeX;
  const entryFeeY = isOneSidedXPosition ? percentageFeeY : percentageFeeY + flatFeeInTokenY;

  const netAmountX = Math.max(0, actualAmountX - entryFeeX);
  const netAmountY = Math.max(0, actualAmountY - entryFeeY);

  // Convert net amounts to raw amounts for Meteora
  const netTotalXAmount = new BN(Math.floor(netAmountX * Math.pow(10, decimalsX)));
  const netTotalYAmount = new BN(Math.floor(netAmountY * Math.pow(10, decimalsY)));

  logger.info("Entry fee calculated", {
    actualAmountX,
    actualAmountY,
    entryFeeX,
    entryFeeY,
    netAmountX,
    netAmountY,
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
    // Use parent org signing for admin wallet
    const signature = await signAndBroadcastAdmin(addLiquidityTx, adminAddress);
    logger.info("Liquidity added by admin", { signature, position: positionKeypair.publicKey.toString() });

    // Step 4: Record position in database (store net amounts that are actually in LP)
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

    // Calculate total USD value for stats tracking (reuse prices fetched earlier)
    const usdValueX = computeUsdValue(actualAmountX, priceX) || 0;
    const usdValueY = computeUsdValue(actualAmountY, priceY) || 0;
    const totalUsdValue = usdValueX + usdValueY;

    // Calculate fee USD values
    const feeUsdValueX = computeUsdValue(entryFeeX, priceX) || 0;
    const feeUsdValueY = computeUsdValue(entryFeeY, priceY) || 0;
    const totalFeeUsd = feeUsdValueX + feeUsdValueY;
    const netUsdValue = totalUsdValue - totalFeeUsd;

    // Audit log
    await createAuditLog({
      agentId,
      action: "add_liquidity",
      asset: poolName,
      amount: netAmountX || netAmountY, // Net amount after fee
      to: poolAddress,
      signature,
      status: "confirmed",
      normalizedUsdAmount: netUsdValue, // Track net value provided as LP
      metadata: {
        positionId: position.id,
        positionPubkey: positionKeypair.publicKey.toString(),
        poolAddress,
        strategy,
        // Gross amounts (deposited by agent)
        depositedAmountX: actualAmountX,
        depositedAmountY: actualAmountY,
        // Entry fees (stay in admin wallet)
        entryFeeX,
        entryFeeY,
        entryFeeBps: FEE_BPS,
        flatFeeUsd: FLAT_FEE_USD,
        totalFeeUsd,
        // Net amounts (actual LP)
        netAmountX,
        netAmountY,
        netUsdValue,
        // Other metadata
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
      // Show both deposited and net amounts
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

    // Attempt to refund tokens to agent (only refund non-zero amounts)
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
    agentId,
    positionId,
    percentage,
  });

  // Policy check BEFORE any transaction is built or signed
  // For removals, we pass usdValue as 0 since it's an inbound operation
  // but we still need to check if liquidity operations are allowed
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

  // Get decimals - fallback to on-chain lookup if SDK doesn't provide them
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
      // Use parent org signing for admin wallet
      await signAndBroadcastAdmin(tx, adminAddress);
    }

    logger.info("Liquidity removed by admin", { positionId, percentage });
  } catch (error) {
    logger.error("Failed to remove liquidity", { error });
    throw new LiquidityError(`Failed to remove liquidity: ${error}`);
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
    throw new LiquidityError(`Failed to transfer proceeds: ${error}`);
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

  // Calculate USD value for stats tracking
  const priceX = await getTokenPriceUsd(position.mintX);
  const priceY = await getTokenPriceUsd(position.mintY);
  const usdValueX = computeUsdValue(netX, priceX) || 0;
  const usdValueY = computeUsdValue(netY, priceY) || 0;
  const totalUsdValue = usdValueX + usdValueY;

  // Audit log
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

  // Get decimals - fallback to on-chain lookup if SDK doesn't provide them
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
      // Use parent org signing for admin wallet
      await signAndBroadcastAdmin(tx, adminAddress);
    }

    logger.info("Rewards claimed by admin", { feeX, feeY });
  } catch (error) {
    logger.error("Failed to claim rewards", { error });
    throw new LiquidityError(`Failed to claim rewards: ${error}`);
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

  // Audit log
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
    positionId,
    agentId,
  });

  // Calculate expected proceeds based on entry amounts
  // (we don't know actual amounts since position is closed, so use entry amounts)
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
        signature: withdrawalSignatureX,
        amount: netX
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
        signature: withdrawalSignatureY,
        amount: netY
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

  // Audit log
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

// =============================================================================
// Position Queries
// =============================================================================

/**
 * Get agent's liquidity positions (basic info from database)
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

export interface PositionDetails {
  id: string;
  poolAddress: string;
  poolName: string | null;
  positionPubkey: string;
  strategy: string;
  symbolX: string | null;
  symbolY: string | null;
  status: string;
  createdAt: string;
  // Current on-chain amounts
  currentAmountX: number;
  currentAmountY: number;
  // Pending rewards (fees earned)
  pendingFeeX: number;
  pendingFeeY: number;
  // Whether there are rewards to claim
  hasRewardsToClaim: boolean;
  // Entry amounts (from database)
  entryAmountX: number;
  entryAmountY: number;
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

  // Get decimals - fallback to on-chain lookup if SDK doesn't provide them
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
    logger.warn("Position not found on-chain - marking as closed in database", {
      positionId,
      positionPubkey: position.positionPubkey
    });

    // Update database to reflect on-chain reality
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
