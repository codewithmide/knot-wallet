import {
  PublicKey,
  SystemProgram,
  VersionedTransaction,
  TransactionMessage,
  LAMPORTS_PER_SOL,
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
} from "@solana/spl-token";
import { connection, signAndBroadcast } from "../turnkey/signer.js";
import { checkPolicy } from "../policy/engine.js";
import { logger } from "../utils/logger.js";
import { InsufficientFundsError } from "../utils/errors.js";
import { createAuditLog } from "../utils/audit.js";
import { config } from "../config.js";
import { getTokenPriceUsd, computeUsdValue } from "../utils/pricing.js";

// Fee configuration
const FEE_PERCENTAGE = 0.01; // 1%
const FLAT_FEE_SOL = 0.001; // ~$0.10-$0.20 depending on SOL price (covers Turnkey costs)
const FLAT_FEE_SPL = 0.10; // $0.10 for SPL tokens (assuming stablecoin-like)

// Fee wallet address (where platform fees are collected)
const getFeeWalletAddress = (): PublicKey | null => {
  const address = config.KNOT_FEE_WALLET_ADDRESS;
  if (!address) return null;
  return new PublicKey(address);
};

export interface TransferResult {
  signature: string;
  explorerUrl: string;
  amount: string;
  amountSent: number; // amount recipient receives
  fee: number; // total fee charged
  totalDeducted: number; // total amount deducted from sender (amountSent + fee)
  feeMode: "added" | "deducted"; // "added" = fee on top, "deducted" = fee from amount
  mint: string | null; // null for native SOL
  recipient: string;
}

/**
 * Transfer native SOL to a recipient address.
 *
 * Fee handling (1% + flat fee):
 * - If user has enough balance: fee is added ON TOP, recipient gets exact amount
 * - If user only has the transfer amount: fee is deducted, recipient gets amount - fee
 */
export async function transferSOL(
  fromAddress: string,
  toAddress: string,
  amountSol: number,
  agentId: string,
  subOrgId: string
): Promise<TransferResult> {
  logger.info("Initiating SOL transfer", { fromAddress, toAddress, amountSol });

  // Calculate fee (1% + flat fee)
  const percentageFee = amountSol * FEE_PERCENTAGE;
  const totalFee = percentageFee + FLAT_FEE_SOL;

  // Get SOL price in USD for policy check
  const NATIVE_SOL_MINT = "So11111111111111111111111111111111111111112";
  const solPriceUsd = await getTokenPriceUsd(NATIVE_SOL_MINT);
  const usdValue = computeUsdValue(amountSol, solPriceUsd);

  if (!usdValue) {
    throw new Error("Unable to determine USD value for SOL transfer. Price data unavailable.");
  }

  // Policy check BEFORE building any transaction
  await checkPolicy(agentId, {
    type: "transfer",
    usdValue,
    to: toAddress,
    asset: "sol",
    amount: amountSol,
  });

  const fromPubkey = new PublicKey(fromAddress);
  const toPubkey = new PublicKey(toAddress);
  const feeWalletPubkey = getFeeWalletAddress();

  // Check balance to determine fee mode
  const balance = await connection.getBalance(fromPubkey);
  const estimatedNetworkFee = 10_000; // lamports for network fee

  // Calculate required balances for both modes
  const requiredForFeeAdded = Math.floor((amountSol + totalFee) * LAMPORTS_PER_SOL) + estimatedNetworkFee;
  const requiredForFeeDeducted = Math.floor(amountSol * LAMPORTS_PER_SOL) + estimatedNetworkFee;

  // Determine fee mode based on balance
  let feeMode: "added" | "deducted";
  let amountToRecipient: number;
  let totalDeducted: number;

  if (balance >= requiredForFeeAdded) {
    // User has enough - fee added on top, recipient gets exact amount
    feeMode = "added";
    amountToRecipient = amountSol;
    totalDeducted = amountSol + totalFee;
    logger.info("SOL transfer: fee added on top (recipient gets exact amount)", {
      amountSol,
      fee: totalFee,
      totalDeducted,
      balance: balance / LAMPORTS_PER_SOL,
    });
  } else if (balance >= requiredForFeeDeducted) {
    // User has only the amount - fee deducted from transfer
    feeMode = "deducted";
    amountToRecipient = amountSol - totalFee;
    totalDeducted = amountSol;

    if (amountToRecipient <= 0) {
      throw new Error(
        `Amount too small. Minimum transfer: ${(totalFee / (1 - FEE_PERCENTAGE)).toFixed(6)} SOL (to cover ${totalFee.toFixed(6)} SOL fee)`
      );
    }

    logger.info("SOL transfer: fee deducted from amount", {
      amountSol,
      fee: totalFee,
      amountToRecipient,
      balance: balance / LAMPORTS_PER_SOL,
    });
  } else {
    throw new InsufficientFundsError(
      `Insufficient balance. Have ${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL, ` +
        `need at least ${(requiredForFeeDeducted / LAMPORTS_PER_SOL).toFixed(6)} SOL (including network fees)`
    );
  }

  const recipientLamports = Math.floor(amountToRecipient * LAMPORTS_PER_SOL);
  const feeLamports = Math.floor(totalFee * LAMPORTS_PER_SOL);

  const { blockhash } = await connection.getLatestBlockhash();

  // Build instructions: transfer to recipient + fee transfer to platform wallet
  const instructions = [
    // Main transfer to recipient
    SystemProgram.transfer({ fromPubkey, toPubkey, lamports: recipientLamports }),
  ];

  // Add fee transfer if fee wallet is configured
  if (feeWalletPubkey && feeLamports > 0) {
    instructions.push(
      SystemProgram.transfer({ fromPubkey, toPubkey: feeWalletPubkey, lamports: feeLamports })
    );
    logger.info("Adding fee transfer instruction", { feeLamports, feeWallet: feeWalletPubkey.toBase58() });
  }

  const message = new TransactionMessage({
    payerKey: fromPubkey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const transaction = new VersionedTransaction(message);

  let signature: string;
  let status: string = "confirmed";

  try {
    signature = await signAndBroadcast(transaction, fromAddress, subOrgId);
  } catch (error) {
    status = "failed";
    // Log the failed attempt
    await createAuditLog({
      agentId,
      action: "transfer",
      asset: "sol",
      amount: amountSol,
      to: toAddress,
      status,
      metadata: { error: String(error), fee: totalFee, amountToRecipient, feeMode },
    });
    throw error;
  }

  // Log successful transfer with USD value
  const feeCollected = !!feeWalletPubkey && feeLamports > 0;
  // const solPriceUsd = await getTokenPriceUsd("So11111111111111111111111111111111111111112");
  const transferUsdValue = computeUsdValue(amountToRecipient, solPriceUsd);

  await createAuditLog({
    agentId,
    action: "transfer_sol",
    asset: "sol",
    amount: amountToRecipient,
    to: toAddress,
    signature,
    status,
    normalizedUsdAmount: transferUsdValue,
    metadata: {
      requestedAmount: amountSol,
      fee: totalFee,
      totalDeducted,
      feeMode,
      feeCollected,
      feeWallet: feeCollected ? feeWalletPubkey.toBase58() : null,
      usdValue: transferUsdValue ?? 0, // For daily limit calculation
    },
  });

  logger.info("SOL transfer completed", {
    signature,
    requestedAmount: amountSol,
    amountToRecipient,
    fee: totalFee,
    feeMode,
    feeCollected,
    toAddress,
  });

  return {
    signature,
    explorerUrl: `https://solscan.io/tx/${signature}`,
    amount: `${amountSol} SOL`,
    amountSent: amountToRecipient,
    fee: totalFee,
    totalDeducted,
    feeMode,
    mint: null,
    recipient: toAddress,
  };
}

/**
 * Transfer any SPL token to a recipient address.
 * Creates the recipient's token account if it doesn't exist.
 *
 * Fee handling (1% + flat fee):
 * - If user has enough balance: fee is added ON TOP, recipient gets exact amount
 * - If user only has the transfer amount: fee is deducted, recipient gets amount - fee
 */
export async function transferSPLToken(
  fromAddress: string,
  toAddress: string,
  mintAddress: string,
  amount: number,
  agentId: string,
  subOrgId: string
): Promise<TransferResult> {
  logger.info("Initiating SPL token transfer", {
    fromAddress,
    toAddress,
    mintAddress,
    amount,
  });

  // Calculate fee (1% + flat fee)
  const percentageFee = amount * FEE_PERCENTAGE;
  const totalFee = percentageFee + FLAT_FEE_SPL;

  // Get token price in USD for policy check
  const tokenPriceUsd = await getTokenPriceUsd(mintAddress);
  const usdValue = computeUsdValue(amount, tokenPriceUsd);

  if (!usdValue) {
    throw new Error("Unable to determine USD value for SPL token transfer. Price data unavailable.");
  }

  // Policy check
  await checkPolicy(agentId, {
    type: "transfer",
    usdValue,
    to: toAddress,
    asset: "spl",
    amount,
    mint: mintAddress,
  });

  const fromPubkey = new PublicKey(fromAddress);
  const toPubkey = new PublicKey(toAddress);
  const mintPubkey = new PublicKey(mintAddress);

  // Detect which token program owns this mint (standard or Token-2022)
  let tokenProgramId = TOKEN_PROGRAM_ID;
  let mintInfo;

  try {
    mintInfo = await getMint(connection, mintPubkey);
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "TokenInvalidAccountOwnerError"
    ) {
      // Try Token-2022
      mintInfo = await getMint(connection, mintPubkey, undefined, TOKEN_2022_PROGRAM_ID);
      tokenProgramId = TOKEN_2022_PROGRAM_ID;
    } else {
      throw error;
    }
  }

  const decimals = mintInfo.decimals;
  const feeWalletPubkey = getFeeWalletAddress();

  // Get token accounts using the correct program
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

  // Get fee wallet token account if configured
  let feeTokenAccount: PublicKey | null = null;
  if (feeWalletPubkey) {
    feeTokenAccount = await getAssociatedTokenAddress(
      mintPubkey,
      feeWalletPubkey,
      false,
      tokenProgramId,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
  }

  // Check sender's balance to determine fee mode
  let senderBalance: number;
  try {
    const fromAccountInfo = await getAccount(connection, fromTokenAccount, undefined, tokenProgramId);
    senderBalance = Number(fromAccountInfo.amount) / Math.pow(10, decimals);
  } catch (error) {
    if ((error as Error).name === "TokenAccountNotFoundError") {
      throw new InsufficientFundsError(
        `No token account found for mint ${mintAddress}. Balance is 0.`
      );
    }
    throw error;
  }

  // Determine fee mode based on balance
  const requiredForFeeAdded = amount + totalFee;
  const requiredForFeeDeducted = amount;

  let feeMode: "added" | "deducted";
  let amountToRecipient: number;
  let totalDeducted: number;

  if (senderBalance >= requiredForFeeAdded) {
    // User has enough - fee added on top, recipient gets exact amount
    feeMode = "added";
    amountToRecipient = amount;
    totalDeducted = amount + totalFee;
    logger.info("SPL transfer: fee added on top (recipient gets exact amount)", {
      amount,
      fee: totalFee,
      totalDeducted,
      balance: senderBalance,
    });
  } else if (senderBalance >= requiredForFeeDeducted) {
    // User has only the amount - fee deducted from transfer
    feeMode = "deducted";
    amountToRecipient = amount - totalFee;
    totalDeducted = amount;

    if (amountToRecipient <= 0) {
      throw new Error(
        `Amount too small. Minimum transfer: ${(totalFee / (1 - FEE_PERCENTAGE)).toFixed(6)} tokens (to cover ${totalFee.toFixed(6)} fee)`
      );
    }

    logger.info("SPL transfer: fee deducted from amount", {
      amount,
      fee: totalFee,
      amountToRecipient,
      balance: senderBalance,
    });
  } else {
    throw new InsufficientFundsError(
      `Insufficient token balance. Have ${senderBalance.toFixed(6)}, need at least ${amount}`
    );
  }

  const rawRecipientAmount = Math.floor(amountToRecipient * Math.pow(10, decimals));
  const rawFeeAmount = Math.floor(totalFee * Math.pow(10, decimals));

  const { blockhash } = await connection.getLatestBlockhash();
  const instructions = [];

  // Create recipient token account if needed
  const toAccountInfo = await connection.getAccountInfo(toTokenAccount);
  if (!toAccountInfo) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        fromPubkey, // payer
        toTokenAccount,
        toPubkey,
        mintPubkey,
        tokenProgramId,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  // Create fee wallet token account if needed
  if (feeWalletPubkey && feeTokenAccount && rawFeeAmount > 0) {
    const feeAccountInfo = await connection.getAccountInfo(feeTokenAccount);
    if (!feeAccountInfo) {
      instructions.push(
        createAssociatedTokenAccountInstruction(
          fromPubkey, // payer (agent pays for fee wallet ATA creation)
          feeTokenAccount,
          feeWalletPubkey,
          mintPubkey,
          tokenProgramId,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }
  }

  // Transfer amount to recipient
  instructions.push(
    createTransferCheckedInstruction(
      fromTokenAccount,
      mintPubkey,
      toTokenAccount,
      fromPubkey,
      rawRecipientAmount,
      decimals,
      [],
      tokenProgramId
    )
  );

  // Transfer fee to platform wallet
  if (feeWalletPubkey && feeTokenAccount && rawFeeAmount > 0) {
    instructions.push(
      createTransferCheckedInstruction(
        fromTokenAccount,
        mintPubkey,
        feeTokenAccount,
        fromPubkey,
        rawFeeAmount,
        decimals,
        [],
        tokenProgramId
      )
    );
    logger.info("Adding SPL fee transfer instruction", { rawFeeAmount, feeWallet: feeWalletPubkey.toBase58() });
  }

  const message = new TransactionMessage({
    payerKey: fromPubkey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const transaction = new VersionedTransaction(message);

  let signature: string;
  let status: string = "confirmed";

  try {
    signature = await signAndBroadcast(transaction, fromAddress, subOrgId);
  } catch (error) {
    status = "failed";
    await createAuditLog({
      agentId,
      action: "transfer",
      asset: mintAddress,
      amount,
      to: toAddress,
      status,
      metadata: { error: String(error), mint: mintAddress, fee: totalFee, amountToRecipient, feeMode },
    });
    throw error;
  }

  // Calculate USD value for the transfer
  const feeCollected = !!feeWalletPubkey && !!feeTokenAccount && rawFeeAmount > 0;
  // const tokenPriceUsd = await getTokenPriceUsd(mintAddress);
  const transferUsdValue = computeUsdValue(amountToRecipient, tokenPriceUsd);

  await createAuditLog({
    agentId,
    action: "transfer_spl",
    asset: mintAddress,
    amount: amountToRecipient,
    to: toAddress,
    signature,
    status,
    normalizedUsdAmount: transferUsdValue,
    metadata: {
      mint: mintAddress,
      decimals,
      requestedAmount: amount,
      fee: totalFee,
      totalDeducted,
      feeMode,
      feeCollected,
      feeWallet: feeCollected ? feeWalletPubkey!.toBase58() : null,
      usdValue: transferUsdValue ?? 0, // For daily limit calculation
    },
  });

  logger.info("SPL token transfer completed", {
    signature,
    requestedAmount: amount,
    amountToRecipient,
    fee: totalFee,
    feeMode,
    feeCollected,
    mintAddress,
    toAddress,
  });

  return {
    signature,
    explorerUrl: `https://solscan.io/tx/${signature}`,
    amount: `${amount}`,
    amountSent: amountToRecipient,
    fee: totalFee,
    totalDeducted,
    feeMode,
    mint: mintAddress,
    recipient: toAddress,
  };
}
