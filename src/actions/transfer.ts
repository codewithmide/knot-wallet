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

export interface TransferResult {
  signature: string;
  explorerUrl: string;
  amount: string;
  mint: string | null; // null for native SOL
  recipient: string;
}

/**
 * Transfer native SOL to a recipient address.
 */
export async function transferSOL(
  fromAddress: string,
  toAddress: string,
  amountSol: number,
  agentId: string,
  subOrgId: string
): Promise<TransferResult> {
  logger.info("Initiating SOL transfer", { fromAddress, toAddress, amountSol });

  // Policy check BEFORE building any transaction
  await checkPolicy(agentId, {
    type: "transfer",
    asset: "sol",
    amount: amountSol,
    to: toAddress,
  });

  const fromPubkey = new PublicKey(fromAddress);
  const toPubkey = new PublicKey(toAddress);
  const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

  // Verify balance
  const balance = await connection.getBalance(fromPubkey);
  const estimatedFee = 10_000; // lamports
  if (balance < lamports + estimatedFee) {
    throw new InsufficientFundsError(
      `Insufficient balance. Have ${balance / LAMPORTS_PER_SOL} SOL, ` +
        `need ${amountSol + estimatedFee / LAMPORTS_PER_SOL} SOL (including fees)`
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
      metadata: { error: String(error) },
    });
    throw error;
  }

  // Log successful transfer
  await createAuditLog({
    agentId,
    action: "transfer",
    asset: "sol",
    amount: amountSol,
    to: toAddress,
    signature,
    status,
  });

  logger.info("SOL transfer completed", { signature, amountSol, toAddress });

  return {
    signature,
    explorerUrl: `https://solscan.io/tx/${signature}`,
    amount: `${amountSol} SOL`,
    mint: null,
    recipient: toAddress,
  };
}

/**
 * Transfer any SPL token to a recipient address.
 * Creates the recipient's token account if it doesn't exist.
 * Automatically fetches token decimals from the mint.
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
  const rawAmount = Math.floor(amount * Math.pow(10, decimals));

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

  // Verify sender has sufficient balance
  try {
    const fromAccountInfo = await getAccount(connection, fromTokenAccount, undefined, tokenProgramId);
    if (Number(fromAccountInfo.amount) < rawAmount) {
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
      metadata: { error: String(error), mint: mintAddress },
    });
    throw error;
  }

  await createAuditLog({
    agentId,
    action: "transfer",
    asset: mintAddress,
    amount,
    to: toAddress,
    signature,
    status,
    metadata: { mint: mintAddress, decimals },
  });

  logger.info("SPL token transfer completed", {
    signature,
    amount,
    mintAddress,
    toAddress,
  });

  return {
    signature,
    explorerUrl: `https://solscan.io/tx/${signature}`,
    amount: `${amount}`,
    mint: mintAddress,
    recipient: toAddress,
  };
}
