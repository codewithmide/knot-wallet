import { config } from "../config.js";
import { logger } from "./logger.js";
import crypto from "crypto";

export interface HeliusWebhookPayload {
  webhookID: string;
  wallet: string;
  nativeTransfers: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    lamports: number;
  }>;
  tokenTransfers: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    fromTokenAccount: string;
    toTokenAccount: string;
    tokenAmount: {
      decimals: number;
      raw: string;
      tokenAccount: string;
    };
    mint: string;
    tokenStandard: string;
  }>;
  nftTransfers: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    fromTokenAccount: string;
    toTokenAccount: string;
    nftData: {
      mint: string;
      standard: string;
      symbol: string;
      name: string;
      uri: string;
      imageUri: string;
      collection: string;
      collectionVerified: boolean;
      royaltyTargets: Array<{
        target: string;
        basisPoints: number;
      }>;
      royaltyBasisPoints: number;
      creators: Array<{
        address: string;
        verified: boolean;
        share: number;
      }>;
    };
  }>;
  transactionType: string;
  activities: Array<{
    type: string;
    amount: number;
    source: string;
    destination: string;
    timestamp: number;
  }>;
}

/**
 * Register a webhook with Helius for a wallet address
 * https://www.helius.dev/docs/api-reference/webhooks#webhooks-api
 */
export async function registerHeliusWebhook(walletAddress: string): Promise<string> {
  const webhookUrl = `${config.API_BASE_URL}/webhooks/helius`;
  const authHeader = config.HELIUS_WEBHOOK_SECRET;

  try {
    logger.info("Registering Helius webhook", { walletAddress, webhookUrl });

    // Helius requires API key as query parameter
    const response = await fetch(`https://api.helius.xyz/v0/webhooks?api-key=${config.HELIUS_API_KEY}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        webhookUrl,
        transactionTypes: ["ANY"], // Listen to all transaction types
        accountAddresses: [walletAddress],
        authHeader, // Pass our secret for authentication
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      logger.error("Helius webhook registration failed", {
        walletAddress,
        status: response.status,
        error: errorData,
      });
      throw new Error(`Helius webhook registration failed: ${response.status} ${errorData}`);
    }

    const data = (await response.json()) as { result: { webhookID: string } };
    const webhookId = data.result.webhookID;

    logger.info("Helius webhook registered successfully", { walletAddress, webhookId });

    return webhookId;
  } catch (err) {
    logger.error("Error registering Helius webhook", { walletAddress, error: String(err) });
    throw err;
  }
}

/**
 * Verify the authenticity of a Helius webhook request
 * Helius signs requests with a SHA256 HMAC using your webhook secret
 */
export function verifyHeliusWebhookSignature(
  payload: string,
  signature: string | undefined
): boolean {
  if (!signature) {
    logger.warn("No signature provided in webhook request");
    return false;
  }

  try {
    // Create HMAC-SHA256 hash of the payload using the webhook secret
    const expectedSignature = crypto
      .createHmac("sha256", config.HELIUS_WEBHOOK_SECRET)
      .update(payload)
      .digest("hex");

    // Compare signatures (constant-time comparison to prevent timing attacks)
    const isValid = crypto.timingSafeEqual(
      Buffer.from(expectedSignature),
      Buffer.from(signature)
    );

    return isValid;
  } catch (err) {
    logger.error("Error verifying webhook signature", { error: String(err) });
    return false;
  }
}

/**
 * Determine if a transaction is an incoming deposit (native SOL or token)
 * Returns the deposit details if it's a deposit, null otherwise
 */
export function parseIncomingDeposit(
  payload: HeliusWebhookPayload,
  walletAddress: string
): { type: "sol" | "spl"; amount: number; mint?: string; from: string } | null {
  // Check native SOL transfers (incoming)
  if (payload.nativeTransfers && payload.nativeTransfers.length > 0) {
    for (const transfer of payload.nativeTransfers) {
      if (transfer.toUserAccount === walletAddress) {
        return {
          type: "sol",
          amount: transfer.lamports,
          from: transfer.fromUserAccount,
        };
      }
    }
  }

  // Check SPL token transfers (incoming)
  if (payload.tokenTransfers && payload.tokenTransfers.length > 0) {
    for (const transfer of payload.tokenTransfers) {
      if (transfer.toUserAccount === walletAddress) {
        return {
          type: "spl",
          amount: parseInt(transfer.tokenAmount.raw),
          mint: transfer.mint,
          from: transfer.fromUserAccount,
        };
      }
    }
  }

  // Check NFT transfers (incoming)
  if (payload.nftTransfers && payload.nftTransfers.length > 0) {
    for (const transfer of payload.nftTransfers) {
      if (transfer.toUserAccount === walletAddress) {
        return {
          type: "spl",
          amount: 1, // NFTs are 1 unit
          mint: transfer.nftData.mint,
          from: transfer.fromUserAccount,
        };
      }
    }
  }

  return null;
}
