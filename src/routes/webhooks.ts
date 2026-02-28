import { Hono } from "hono";
import { verifyHeliusWebhookAuth } from "../utils/helius.js";
import { db } from "../db/prisma.js";
import { logger } from "../utils/logger.js";
import { success, error } from "../utils/response.js";
import { createAuditLog } from "../utils/audit.js";
import { computeUsdValue, getTokenPriceUsd } from "../utils/pricing.js";
import { sendDepositNotification } from "../utils/email.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";

const webhooks = new Hono();

// Track processed signatures to prevent duplicate processing
// Uses a simple in-memory cache with TTL
const processedSignatures = new Map<string, number>();
const SIGNATURE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function isSignatureProcessed(signature: string): boolean {
  const timestamp = processedSignatures.get(signature);
  if (!timestamp) return false;

  // Check if still within TTL
  if (Date.now() - timestamp < SIGNATURE_TTL_MS) {
    return true;
  }

  // Expired, remove it
  processedSignatures.delete(signature);
  return false;
}

function markSignatureProcessed(signature: string): void {
  processedSignatures.set(signature, Date.now());

  // Cleanup old entries periodically (every 100 new entries)
  if (processedSignatures.size > 100) {
    const now = Date.now();
    for (const [sig, ts] of processedSignatures) {
      if (now - ts > SIGNATURE_TTL_MS) {
        processedSignatures.delete(sig);
      }
    }
  }
}

interface DepositInfo {
  amount: number;
  asset: string;
  assetName: string;
  usdValue: number | null;
  from: string;
}

interface AgentDeposits {
  email: string;
  agentId: string;
  deposits: DepositInfo[];
  totalUsdValue: number | null;
}

/**
 * POST /webhooks/helius
 * Receives webhook notifications from Helius for wallet transactions
 * Verifies auth header and logs incoming deposits
 */
webhooks.post("/helius", async (c) => {
  try {
    const rawBody = await c.req.text();
    const authHeader = c.req.header("Authorization");

    if (!verifyHeliusWebhookAuth(authHeader)) {
      logger.warn("Invalid webhook auth header received");
      return error(c, "Invalid webhook signature", 401);
    }

    const rawPayload = JSON.parse(rawBody);
    const transactions = Array.isArray(rawPayload) ? rawPayload : [rawPayload];

    let depositsProcessed = 0;

    for (const tx of transactions) {
      const signature = tx.signature;

      // Skip if we've already processed this signature recently
      if (isSignatureProcessed(signature)) {
        logger.info("Skipping duplicate webhook for signature", { signature });
        continue;
      }

      logger.info("Processing transaction", {
        type: tx.type,
        signature,
        feePayer: tx.feePayer,
      });

      const nativeTransfers = tx.nativeTransfers || [];
      const tokenTransfers = tx.tokenTransfers || [];

      // Aggregate deposits by agent
      const agentDepositsMap = new Map<string, AgentDeposits>();

      // Process native SOL transfers
      for (const transfer of nativeTransfers) {
        const toAddress = transfer.toUserAccount;

        const agent = await db.agent.findUnique({
          where: { solanaAddress: toAddress },
        });

        if (agent) {
          const solAmount = transfer.amount / 1e9;
          const priceUsd = await getTokenPriceUsd(SOL_MINT);
          const normalizedUsdAmount = computeUsdValue(solAmount, priceUsd);

          // Log the deposit
          await createAuditLog({
            agentId: agent.id,
            action: "deposit",
            asset: "sol",
            amount: solAmount,
            to: toAddress,
            from: transfer.fromUserAccount,
            status: "confirmed",
            signature,
            normalizedUsdAmount,
            metadata: {
              transactionType: tx.type,
              depositType: "sol",
              rawAmount: transfer.amount.toString(),
              priceUsd,
              normalizedUsdAmount,
            },
          });
          depositsProcessed++;

          // Aggregate for email notification
          if (!agentDepositsMap.has(agent.id)) {
            agentDepositsMap.set(agent.id, {
              email: agent.email,
              agentId: agent.id,
              deposits: [],
              totalUsdValue: 0,
            });
          }

          const agentData = agentDepositsMap.get(agent.id)!;
          agentData.deposits.push({
            amount: solAmount,
            asset: "sol",
            assetName: "SOL",
            usdValue: normalizedUsdAmount,
            from: transfer.fromUserAccount,
          });
          if (normalizedUsdAmount !== null) {
            agentData.totalUsdValue = (agentData.totalUsdValue || 0) + normalizedUsdAmount;
          }

          logger.info("SOL deposit logged", {
            agent: agent.email,
            amount: solAmount,
            from: transfer.fromUserAccount,
          });
        }
      }

      // Process SPL token transfers
      for (const transfer of tokenTransfers) {
        const toAddress = transfer.toUserAccount;

        const agent = await db.agent.findUnique({
          where: { solanaAddress: toAddress },
        });

        if (agent) {
          const tokenAmount = Number(transfer.tokenAmount);
          const priceUsd = await getTokenPriceUsd(transfer.mint);
          const normalizedUsdAmount = computeUsdValue(tokenAmount, priceUsd);

          await createAuditLog({
            agentId: agent.id,
            action: "deposit",
            asset: transfer.mint,
            amount: tokenAmount,
            to: toAddress,
            from: transfer.fromUserAccount,
            status: "confirmed",
            signature,
            normalizedUsdAmount,
            metadata: {
              transactionType: tx.type,
              depositType: "spl",
              mint: transfer.mint,
              rawAmount: transfer.tokenAmount.toString(),
              priceUsd,
              normalizedUsdAmount,
            },
          });
          depositsProcessed++;

          // Aggregate for email notification
          if (!agentDepositsMap.has(agent.id)) {
            agentDepositsMap.set(agent.id, {
              email: agent.email,
              agentId: agent.id,
              deposits: [],
              totalUsdValue: 0,
            });
          }

          const agentData = agentDepositsMap.get(agent.id)!;
          agentData.deposits.push({
            amount: tokenAmount,
            asset: transfer.mint,
            assetName: transfer.mint, // Will be resolved in email function if needed
            usdValue: normalizedUsdAmount,
            from: transfer.fromUserAccount,
          });
          if (normalizedUsdAmount !== null) {
            agentData.totalUsdValue = (agentData.totalUsdValue || 0) + normalizedUsdAmount;
          }

          logger.info("Token deposit logged", {
            agent: agent.email,
            mint: transfer.mint,
            amount: tokenAmount,
          });
        }
      }

      // Send ONE consolidated email per agent for this transaction
      for (const [_agentId, agentData] of agentDepositsMap) {
        if (agentData.deposits.length === 0) continue;

        // Use the first deposit for the main notification
        // If multiple deposits, we'll include total USD value
        const primaryDeposit = agentData.deposits[0];

        // For multiple deposits, sum up the amounts if same asset, or use total USD
        let displayAmount = primaryDeposit.amount;
        let displayAsset = primaryDeposit.assetName;

        if (agentData.deposits.length > 1) {
          // Multiple deposits - show total USD value if available
          displayAsset = `${agentData.deposits.length} assets`;
        }

        sendDepositNotification(
          agentData.email,
          displayAmount,
          displayAsset,
          agentData.totalUsdValue,
          signature
        ).catch((err) => {
          logger.error("Failed to send deposit notification", {
            agent: agentData.email,
            error: String(err)
          });
        });
      }

      // Mark this signature as processed
      markSignatureProcessed(signature);
    }

    return success(c, "Webhook processed successfully", {
      transactionsReceived: transactions.length,
      depositsProcessed,
    });
  } catch (err) {
    logger.error("Error processing webhook", { error: String(err) });
    return success(c, "Webhook acknowledged with errors", { error: String(err) });
  }
});

export { webhooks };
