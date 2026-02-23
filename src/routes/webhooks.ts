import { Hono } from "hono";
import { verifyHeliusWebhookAuth, parseIncomingDeposit, HeliusWebhookPayload } from "../utils/helius.js";
import { db } from "../db/prisma.js";
import { logger } from "../utils/logger.js";
import { success, error } from "../utils/response.js";

const webhooks = new Hono();

/**
 * POST /webhooks/helius
 * Receives webhook notifications from Helius for wallet transactions
 * Verifies auth header and logs incoming deposits
 */
webhooks.post("/helius", async (c) => {
  logger.info("Webhook endpoint hit!");
  
  try {
    // Get the raw body for parsing
    const rawBody = await c.req.text();
    logger.info("Webhook payload received", { bodyLength: rawBody.length });

    // Get the Authorization header (Helius sends authHeader value here)
    const authHeader = c.req.header("Authorization");
    logger.info("Webhook auth check", { hasAuth: !!authHeader });

    // Verify auth header matches our secret
    if (!verifyHeliusWebhookAuth(authHeader)) {
      logger.warn("Invalid webhook auth header received");
      return error(c, "Invalid webhook signature", 401);
    }

    // Parse the payload
    const payload = JSON.parse(rawBody) as HeliusWebhookPayload;

    logger.info("Webhook received", {
      wallet: payload.wallet,
      transactionType: payload.transactionType,
    });

    // Find the agent that owns this wallet
    const agent = await db.agent.findUnique({
      where: { solanaAddress: payload.wallet },
    });

    if (!agent) {
      logger.warn("Webhook received for unknown wallet", { wallet: payload.wallet });
      // Still return 200 to acknowledge receipt (Helius expects 2xx response)
      return success(c, "Webhook received but agent not found", {});
    }

    // Check if this is an incoming deposit
    const deposit = parseIncomingDeposit(payload, payload.wallet);

    if (deposit) {
      // Log the deposit as an audit entry
      try {
        await db.auditLog.create({
          data: {
            agentId: agent.id,
            action: "deposit",
            asset: deposit.type === "sol" ? "sol" : deposit.mint || "unknown",
            amount: deposit.type === "sol" ? deposit.amount / 1e9 : deposit.amount, // Convert lamports to SOL for display
            to: payload.wallet,
            from: deposit.from,
            status: "confirmed",
            signature: payload.webhookID, // Use webhook ID as reference
            metadata: {
              transactionType: payload.transactionType,
              depositType: deposit.type,
              rawAmount: deposit.amount.toString(),
            },
          },
        });

        logger.info("Deposit logged", {
          agentId: agent.id,
          from: deposit.from,
          amount: deposit.amount,
          type: deposit.type,
        });
      } catch (err) {
        logger.error("Failed to log deposit", {
          agentId: agent.id,
          error: String(err),
        });
        // Don't fail the webhook response - we want to ack the webhook regardless
      }
    } else {
      logger.debug("No incoming deposit detected", { wallet: payload.wallet });
    }

    // Always return 200 OK to acknowledge receipt
    return success(c, "Webhook processed successfully", {
      wallet: payload.wallet,
      depositDetected: !!deposit,
    });
  } catch (err) {
    logger.error("Error processing webhook", { error: String(err) });

    // Return 200 anyway - don't want Helius to retry on our parsing errors
    return success(c, "Webhook acknowledged with errors", { error: String(err) });
  }
});

export { webhooks };
