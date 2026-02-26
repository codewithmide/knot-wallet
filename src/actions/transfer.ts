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

// Fee configuration
const FEE_PERCENTAGE = 0.01; // 1%
const FLAT_FEE_SOL = 0.001; // ~$0.10-$0.20 depending on SOL price (covers Turnkey costs)
const FLAT_FEE_SPL = 0.10; // $0.10 for SPL tokens (assuming stablecoin-like)

export interface TransferResult {
  signature: string;
  explorerUrl: string;
  amount: string;
  amountSent: number; // net amount after fee
  fee: number; // total fee deducted
  mint: string | null; // null for native SOL
  recipient: string;
}

/**
 * Transfer native SOL to a recipient address.
 * Fee (1% + flat fee) is deducted from the transfer amount.
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
  const netAmount = amountSol - totalFee;

  if (netAmount <= 0) {
    throw new Error(
      `Amount too small. Minimum transfer: ${(totalFee / (1 - FEE_PERCENTAGE)).toFixed(6)} SOL (to cover ${totalFee.toFixed(6)} SOL fee)`
    );
  }

  logger.info("SOL transfer fees", { amountSol, percentageFee, flatFee: FLAT_FEE_SOL, totalFee, netAmount });

  // Policy check BEFORE building any transaction
  await checkPolicy(agentId, {
    type: "transfer",
    asset: "sol",
    amount: amountSol,
    to: toAddress,
  });

  const fromPubkey = new PublicKey(fromAddress);
  const toPubkey = new PublicKey(toAddress);
  const lamports = Math.floor(netAmount * LAMPORTS_PER_SOL);

  // Verify balance (user needs full amount, fee is deducted from what's sent)
  const balance = await connection.getBalance(fromPubkey);
  const estimatedNetworkFee = 10_000; // lamports for network fee
  const requiredBalance = Math.floor(amountSol * LAMPORTS_PER_SOL) + estimatedNetworkFee;
  if (balance < requiredBalance) {
    throw new InsufficientFundsError(
      `Insufficient balance. Have ${balance / LAMPORTS_PER_SOL} SOL, ` +
        `need ${requiredBalance / LAMPORTS_PER_SOL} SOL (including network fees)`
    );
  }

  const { blockhash } = await connection.getLatestBlockhash();

  const message = new TransactionMessage({
    payerKey: fromPubkey,
    recentBlockhash: blockhash,
    instructions: [SystemProgram.transfer({ fromPubkey, toPubkey, lamports })],
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
      metadata: { error: String(error), fee: totalFee, netAmount },
    });
    throw error;
  }

  // Log successful transfer
  await createAuditLog({
    agentId,
    action: "transfer",
    asset: "sol",
    amount: netAmount,
    to: toAddress,
    signature,
    status,
    metadata: { requestedAmount: amountSol, fee: totalFee },
  });

  logger.info("SOL transfer completed", { signature, amountSol, netAmount, fee: totalFee, toAddress });

  return {
    signature,
    explorerUrl: `https://solscan.io/tx/${signature}`,
    amount: `${amountSol} SOL`,
    amountSent: netAmount,
    fee: totalFee,
    mint: null,
    recipient: toAddress,
  };
}

/**
 * Transfer any SPL token to a recipient address.
 * Creates the recipient's token account if it doesn't exist.
 * Fee (1% + flat fee) is deducted from the transfer amount.
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
  const netAmount = amount - totalFee;

  if (netAmount <= 0) {
    throw new Error(
      `Amount too small. Minimum transfer: ${(totalFee / (1 - FEE_PERCENTAGE)).toFixed(6)} tokens (to cover ${totalFee.toFixed(6)} fee)`
    );
  }

  logger.info("SPL transfer fees", { amount, percentageFee, flatFee: FLAT_FEE_SPL, totalFee, netAmount });

  // Policy check
  await checkPolicy(agentId, {
    type: "transfer",
    asset: "spl",
    amount,
    to: toAddress,
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
  const rawNetAmount = Math.floor(netAmount * Math.pow(10, decimals));

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

  // Verify sender has sufficient balance (full amount including what becomes fee)
  const rawFullAmount = Math.floor(amount * Math.pow(10, decimals));
  try {
    const fromAccountInfo = await getAccount(connection, fromTokenAccount, undefined, tokenProgramId);
    if (Number(fromAccountInfo.amount) < rawFullAmount) {
      throw new InsufficientFundsError(
        `Insufficient token balance. Have ${Number(fromAccountInfo.amount) / Math.pow(10, decimals)}, need ${amount}`
      );
    }
  } catch (error) {
    if ((error as Error).name === "TokenAccountNotFoundError") {
      throw new InsufficientFundsError(
        `No token account found for mint ${mintAddress}. Balance is 0.`
      );
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
        fromPubkey, // payer
        toTokenAccount,
        toPubkey,
        mintPubkey,
        tokenProgramId,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  // Use transfer_checked for Token-2022 compatibility (required for tokens with extensions)
  // Transfer net amount (after fee deduction)
  instructions.push(
    createTransferCheckedInstruction(
      fromTokenAccount,
      mintPubkey,
      toTokenAccount,
      fromPubkey,
      rawNetAmount,
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
      metadata: { error: String(error), mint: mintAddress, fee: totalFee, netAmount },
    });
    throw error;
  }

  await createAuditLog({
    agentId,
    action: "transfer",
    asset: mintAddress,
    amount: netAmount,
    to: toAddress,
    signature,
    status,
    metadata: { mint: mintAddress, decimals, requestedAmount: amount, fee: totalFee },
  });

  logger.info("SPL token transfer completed", {
    signature,
    amount,
    netAmount,
    fee: totalFee,
    mintAddress,
    toAddress,
  });

  return {
    signature,
    explorerUrl: `https://solscan.io/tx/${signature}`,
    amount: `${amount}`,
    amountSent: netAmount,
    fee: totalFee,
    mint: mintAddress,
    recipient: toAddress,
  };
}
