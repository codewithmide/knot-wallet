import {
  Connection,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { TurnkeySigner } from "@turnkey/solana";
import { turnkeyClient, turnkeyDelegatedClient } from "./client.js";
import { config, getSolanaRpcUrl } from "../config.js";
import { logger } from "../utils/logger.js";

// Main connection (mainnet or devnet based on config)
const connection = new Connection(getSolanaRpcUrl(), "confirmed");

// Explicit devnet connection (used in tests and faucet)
export const devnetConnection = new Connection(
  `https://devnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`,
  "confirmed"
);

export { connection };

/**
 * Signs a pre-built VersionedTransaction using Turnkey (TEE),
 * then broadcasts to Solana. Returns the transaction signature.
 *
 * The private key never leaves Turnkey's enclave.
 *
 * @param organizationId - The Turnkey sub-organization ID for this wallet
 */
export async function signAndBroadcast(
  transaction: VersionedTransaction,
  signerAddress: string,
  organizationId: string,
  network: "mainnet" | "devnet" = "mainnet"
): Promise<string> {
  const conn = network === "devnet" ? devnetConnection : connection;

  // Set a fresh blockhash before signing
  const { blockhash, lastValidBlockHeight } =
    await conn.getLatestBlockhash("confirmed");
  transaction.message.recentBlockhash = blockhash;

  logger.debug("Signing transaction", { signerAddress, organizationId, network });

  // TurnkeySigner wraps our delegated client and handles the TEE signing call
  // Use the agent's sub-organization ID where the delegated user has signing rights
  const turnkeySigner = new TurnkeySigner({
    organizationId,
    client: turnkeyDelegatedClient,
  });

  // Signing happens server-side in Turnkey's TEE
  await turnkeySigner.addSignature(transaction, signerAddress);

  // Broadcast with Helius for optimal landing rate
  const rawTx = transaction.serialize();
  const signature = await conn.sendRawTransaction(rawTx, {
    skipPreflight: false,
    maxRetries: 3,
    preflightCommitment: "confirmed",
  });

  logger.info("Transaction broadcast", { signature });

  // Wait for confirmation
  await conn.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed"
  );

  logger.info("Transaction confirmed", { signature });

  return signature;
}

/**
 * Signs and broadcasts using the PARENT organization client.
 * Use this for admin wallet operations (wallet in parent org, not a sub-org).
 *
 * Uses turnkeyClient (parent API keys) instead of turnkeyDelegatedClient.
 */
export async function signAndBroadcastAdmin(
  transaction: VersionedTransaction,
  signerAddress: string,
  network: "mainnet" | "devnet" = "mainnet"
): Promise<string> {
  const conn = network === "devnet" ? devnetConnection : connection;

  // Set a fresh blockhash before signing
  const { blockhash, lastValidBlockHeight } =
    await conn.getLatestBlockhash("confirmed");
  transaction.message.recentBlockhash = blockhash;

  logger.debug("Signing admin transaction", { signerAddress, network });

  // Use parent org client for admin wallet
  const turnkeySigner = new TurnkeySigner({
    organizationId: config.TURNKEY_ORGANIZATION_ID,
    client: turnkeyClient,
  });

  // Signing happens server-side in Turnkey's TEE
  await turnkeySigner.addSignature(transaction, signerAddress);

  // Broadcast with Helius for optimal landing rate
  const rawTx = transaction.serialize();
  const signature = await conn.sendRawTransaction(rawTx, {
    skipPreflight: false,
    maxRetries: 3,
    preflightCommitment: "confirmed",
  });

  logger.info("Admin transaction broadcast", { signature });

  // Wait for confirmation
  await conn.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed"
  );

  logger.info("Admin transaction confirmed", { signature });

  return signature;
}

/**
 * Sign a transaction using Turnkey but DON'T broadcast.
 * Returns base64-encoded signed transaction.
 * Use this for services like Jupiter Ultra that handle their own broadcasting.
 *
 * @param organizationId - The Turnkey sub-organization ID for this wallet
 */
export async function signTransaction(
  transaction: VersionedTransaction,
  signerAddress: string,
  organizationId: string
): Promise<string> {
  logger.debug("Signing transaction (no broadcast)", { signerAddress, organizationId });

  const turnkeySigner = new TurnkeySigner({
    organizationId,
    client: turnkeyDelegatedClient,
  });

  // Signing happens server-side in Turnkey's TEE
  await turnkeySigner.addSignature(transaction, signerAddress);

  // Return base64-encoded signed transaction
  const signedTx = Buffer.from(transaction.serialize()).toString("base64");
  logger.debug("Transaction signed", { signerAddress });

  return signedTx;
}

/**
 * Sign a transaction for admin wallet using PARENT organization client.
 * Returns base64-encoded signed transaction without broadcasting.
 * Use this for admin operations with Jupiter Ultra.
 */
export async function signTransactionAdmin(
  transaction: VersionedTransaction,
  signerAddress: string
): Promise<string> {
  logger.debug("Signing admin transaction (no broadcast)", { signerAddress });

  const turnkeySigner = new TurnkeySigner({
    organizationId: config.TURNKEY_ORGANIZATION_ID,
    client: turnkeyClient,
  });

  // Signing happens server-side in Turnkey's TEE
  await turnkeySigner.addSignature(transaction, signerAddress);

  // Return base64-encoded signed transaction
  const signedTx = Buffer.from(transaction.serialize()).toString("base64");
  logger.debug("Admin transaction signed", { signerAddress });

  return signedTx;
}

/**
 * Sign a raw message (e.g. for Sign In With Solana, identity proofs).
 * Returns hex-encoded signature.
 *
 * @param organizationId - The Turnkey sub-organization ID for this wallet
 */
export async function signMessage(
  message: string,
  signerAddress: string,
  organizationId: string
): Promise<string> {
  const messageBytes = Buffer.from(message, "utf-8");

  logger.debug("Signing message", { signerAddress, organizationId, messageLength: message.length });

  const result = await turnkeyDelegatedClient.signRawPayload({
    organizationId,
    signWith: signerAddress,
    payload: messageBytes.toString("hex"),
    encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
    hashFunction: "HASH_FUNCTION_NOT_APPLICABLE",
  });

  // Ed25519 signature is r + s concatenated
  return `${result.r}${result.s}`;
}

/**
 * Simulate a transaction WITHOUT signing.
 * Use this before any arbitrary transaction signing to understand effects.
 */
export async function simulateTransaction(
  transaction: VersionedTransaction,
  network: "mainnet" | "devnet" = "mainnet"
): Promise<{ success: boolean; logs: string[] | null; error: string | null }> {
  const conn = network === "devnet" ? devnetConnection : connection;

  const result = await conn.simulateTransaction(transaction, {
    commitment: "confirmed",
    replaceRecentBlockhash: true,
  });

  if (result.value.err) {
    return {
      success: false,
      logs: result.value.logs,
      error: JSON.stringify(result.value.err),
    };
  }

  return { success: true, logs: result.value.logs, error: null };
}
