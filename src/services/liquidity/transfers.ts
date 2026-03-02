import {
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  SystemProgram,
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
  NATIVE_MINT,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import { connection, signAndBroadcast, signAndBroadcastAdmin } from "../../turnkey/signer.js";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { LiquidityError } from "../../utils/errors.js";

// Rent cost for creating a token account (~0.00204 SOL)
const TOKEN_ACCOUNT_RENT = 2039280; // lamports

/**
 * Detect which token program owns a mint (standard vs Token-2022).
 * Returns { tokenProgramId, mintInfo }.
 */
async function detectTokenProgram(mintPubkey: PublicKey) {
  try {
    const mintInfo = await getMint(connection, mintPubkey, undefined, TOKEN_PROGRAM_ID);
    return { tokenProgramId: TOKEN_PROGRAM_ID, mintInfo };
  } catch (error) {
    logger.info("Standard Token Program failed, trying Token-2022", {
      mint: mintPubkey.toString(),
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      const mintInfo = await getMint(connection, mintPubkey, undefined, TOKEN_2022_PROGRAM_ID);
      logger.info("Token-2022 detected for mint", { mint: mintPubkey.toString() });
      return { tokenProgramId: TOKEN_2022_PROGRAM_ID, mintInfo };
    } catch (token2022Error) {
      logger.error("Both Token Program and Token-2022 failed", {
        mint: mintPubkey.toString(),
        standardError: error instanceof Error ? error.message : String(error),
        token2022Error: token2022Error instanceof Error ? token2022Error.message : String(token2022Error),
      });
      throw error;
    }
  }
}

/**
 * Transfer SPL token from agent to admin wallet.
 * Handles both standard Token Program and Token-2022.
 * Special handling for native SOL: wraps to wSOL if needed.
 */
export async function transferTokenToAdmin(
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

  const { tokenProgramId, mintInfo } = await detectTokenProgram(mintPubkey);
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

  // Check if admin's token account exists (needed for fee calculation)
  const adminAccountInfo = await connection.getAccountInfo(toTokenAccount);
  const needsAdminAccount = !adminAccountInfo;

  // Check if user has wSOL token account
  let needsWrapping = false;

  try {
    const accountInfo = await getAccount(connection, fromTokenAccount, undefined, tokenProgramId);
    if (Number(accountInfo.amount) < rawAmount) {
      // Has wSOL account but not enough balance
      if (isNativeSol) {
        // Check if they have enough native SOL to top up
        const nativeBalance = await connection.getBalance(fromPubkey);
        const existingWsol = Number(accountInfo.amount);
        const neededNativeLamports = rawAmount - existingWsol;
        const rentForAdminAta = needsAdminAccount ? TOKEN_ACCOUNT_RENT : 0;
        const networkFee = 10000;
        const totalNeeded = neededNativeLamports + rentForAdminAta + networkFee;

        if (nativeBalance >= totalNeeded) {
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
        throw new LiquidityError(
          `Insufficient balance. Have ${Number(accountInfo.amount) / Math.pow(10, decimals)}, need ${amount}`
        );
      }
    }
  } catch (error) {
    if ((error as Error).name === "TokenAccountNotFoundError") {
      // No wSOL token account exists
      if (isNativeSol) {
        const nativeBalance = await connection.getBalance(fromPubkey);
        const rentForUserAta = TOKEN_ACCOUNT_RENT;
        const rentForAdminAta = needsAdminAccount ? TOKEN_ACCOUNT_RENT : 0;
        const networkFee = 10000;
        const totalNeeded = rawAmount + rentForUserAta + rentForAdminAta + networkFee;

        if (nativeBalance >= totalNeeded) {
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
    instructions.push(
      SystemProgram.transfer({
        fromPubkey,
        toPubkey: fromTokenAccount,
        lamports: rawAmount,
      })
    );
    instructions.push(
      createSyncNativeInstruction(fromTokenAccount, tokenProgramId)
    );
    logger.info("Added SOL wrapping instructions", { amount, rawAmount });
  }

  // Create recipient token account if needed
  if (!adminAccountInfo) {
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
 * Transfer SPL token from admin to agent wallet.
 * Handles both standard Token Program and Token-2022.
 * Special handling for wSOL: automatically unwraps to native SOL.
 */
export async function transferTokenFromAdmin(
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

  const { tokenProgramId, mintInfo } = await detectTokenProgram(mintPubkey);
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

    const fromAccountInfo = await connection.getAccountInfo(fromTokenAccount);

    if (fromAccountInfo) {
      // Admin has wSOL token account — close it to unwrap to native SOL
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
      logger.info("Admin doesn't have wSOL account — has native SOL already");
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
    // For regular SPL tokens, do standard token transfer

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
