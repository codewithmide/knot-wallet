import { logger } from "../../utils/logger.js";
import { config } from "../../config.js";
import { connection, signAndBroadcast, signAndBroadcastAdmin } from "../../turnkey/signer.js";
import {
  PublicKey,
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
import { USDC_MINT } from "./types.js";

// =============================================================================
// Internal USDC Transfer Helpers
// =============================================================================

/**
 * Internal: Transfer USDC from agent wallet to admin wallet
 */
export async function transferUSDCToAdmin(
  fromAddress: string,
  toAddress: string,
  amount: number,
  subOrgId: string
): Promise<string> {
  const fromPubkey = new PublicKey(fromAddress);
  const toPubkey = new PublicKey(toAddress);

  // Get mint info for decimals
  const mintInfo = await getMint(connection, USDC_MINT);
  const decimals = mintInfo.decimals;
  const rawAmount = Math.floor(amount * Math.pow(10, decimals));

  // Get token accounts
  const fromTokenAccount = await getAssociatedTokenAddress(
    USDC_MINT,
    fromPubkey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const toTokenAccount = await getAssociatedTokenAddress(
    USDC_MINT,
    toPubkey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // Verify sender has sufficient balance
  try {
    const fromAccountInfo = await getAccount(connection, fromTokenAccount, undefined, TOKEN_PROGRAM_ID);
    if (Number(fromAccountInfo.amount) < rawAmount) {
      throw new Error(
        `Insufficient USDC balance. Have ${Number(fromAccountInfo.amount) / Math.pow(10, decimals)}, need ${amount}`
      );
    }
  } catch (error) {
    if ((error as Error).name === "TokenAccountNotFoundError") {
      throw new Error(`No USDC account found. Balance is 0.`);
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
        USDC_MINT,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  // Transfer USDC
  instructions.push(
    createTransferCheckedInstruction(
      fromTokenAccount,
      USDC_MINT,
      toTokenAccount,
      fromPubkey,
      rawAmount,
      decimals,
      [],
      TOKEN_PROGRAM_ID
    )
  );

  const message = new TransactionMessage({
    payerKey: fromPubkey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const transaction = new VersionedTransaction(message);

  // Sign and broadcast using agent's sub-org
  const signature = await signAndBroadcast(transaction, fromAddress, subOrgId);

  logger.info("USDC transfer to admin completed", { signature, amount });

  return signature;
}

/**
 * Internal: Transfer USDC from admin wallet to agent wallet
 */
export async function transferUSDCFromAdmin(
  toAddress: string,
  amount: number
): Promise<string> {
  const adminAddress = config.KNOT_KALSHI_ADMIN_WALLET_ADDRESS;

  const fromPubkey = new PublicKey(adminAddress);
  const toPubkey = new PublicKey(toAddress);

  // Get mint info for decimals
  const mintInfo = await getMint(connection, USDC_MINT);
  const decimals = mintInfo.decimals;
  const rawAmount = Math.floor(amount * Math.pow(10, decimals));

  // Get token accounts
  const fromTokenAccount = await getAssociatedTokenAddress(
    USDC_MINT,
    fromPubkey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const toTokenAccount = await getAssociatedTokenAddress(
    USDC_MINT,
    toPubkey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // Verify admin wallet has sufficient balance
  try {
    const fromAccountInfo = await getAccount(connection, fromTokenAccount, undefined, TOKEN_PROGRAM_ID);
    if (Number(fromAccountInfo.amount) < rawAmount) {
      throw new Error(
        `Admin wallet has insufficient USDC. This is a system error - please contact support.`
      );
    }
  } catch (error) {
    if ((error as Error).name === "TokenAccountNotFoundError") {
      throw new Error(`Admin wallet has no USDC. This is a system error - please contact support.`);
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
        fromPubkey, // payer (admin pays for account creation)
        toTokenAccount,
        toPubkey,
        USDC_MINT,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  // Transfer USDC
  instructions.push(
    createTransferCheckedInstruction(
      fromTokenAccount,
      USDC_MINT,
      toTokenAccount,
      fromPubkey,
      rawAmount,
      decimals,
      [],
      TOKEN_PROGRAM_ID
    )
  );

  const message = new TransactionMessage({
    payerKey: fromPubkey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const transaction = new VersionedTransaction(message);

  // Sign and broadcast using admin wallet in parent org
  const signature = await signAndBroadcastAdmin(transaction, adminAddress);

  logger.info("USDC transfer from admin completed", { signature, amount, toAddress });

  return signature;
}
