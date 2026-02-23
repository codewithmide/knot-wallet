import { Hono } from "hono";
import { verifyHeliusWebhookAuth } from "../utils/helius.js";
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

    // Parse the payload - Helius sends an array of transactions
    const rawPayload = JSON.parse(rawBody);
    logger.info("Webhook raw payload type", { isArray: Array.isArray(rawPayload) });
    
    // Handle both array and single object formats
    const transactions = Array.isArray(rawPayload) ? rawPayload : [rawPayload];
    
    let depositsProcessed = 0;
    
    for (const tx of transactions) {
      // Log full transaction for debugging
      logger.info("Processing transaction", { 
        type: tx.type,
        signature: tx.signature,
        feePayer: tx.feePayer,
      });
      
      // For enhanced transactions, look at nativeTransfers and tokenTransfers
      const nativeTransfers = tx.nativeTransfers || [];
      const tokenTransfers = tx.tokenTransfers || [];
      
      // Process native SOL transfers
      for (const transfer of nativeTransfers) {
        const toAddress = transfer.toUserAccount;
        
        // Find if recipient is one of our agents
        const agent = await db.agent.findUnique({
          where: { solanaAddress: toAddress },
        });
        
        if (agent) {
          // This is a deposit to one of our wallets
          await db.auditLog.create({
            data: {
              agentId: agent.id,
              action: "deposit",
              asset: "sol",
              amount: transfer.amount / 1e9, // Convert lamports to SOL
              to: toAddress,
              from: transfer.fromUserAccount,
              status: "confirmed",
              signature: tx.signature,
              metadata: {
                transactionType: tx.type,
                depositType: "sol",
                rawAmount: transfer.amount.toString(),
              },
            },
          });
          depositsProcessed++;
          logger.info("SOL deposit logged", { 
            agent: agent.email, 
            amount: transfer.amount / 1e9,
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
          await db.auditLog.create({
            data: {
              agentId: agent.id,
              action: "deposit",
              asset: transfer.mint,
              amount: transfer.tokenAmount,
              to: toAddress,
              from: transfer.fromUserAccount,
              status: "confirmed",
              signature: tx.signature,
              metadata: {
                transactionType: tx.type,
                depositType: "spl",
                mint: transfer.mint,
                rawAmount: transfer.tokenAmount.toString(),
              },
            },
          });
          depositsProcessed++;
          logger.info("Token deposit logged", { 
            agent: agent.email, 
            mint: transfer.mint,
            amount: transfer.tokenAmount,
          });
        }
      }
    }

    // Always return 200 OK to acknowledge receipt
    return success(c, "Webhook processed successfully", {
      transactionsReceived: transactions.length,
      depositsProcessed,
    });
  } catch (err) {
    logger.error("Error processing webhook", { error: String(err) });

    // Return 200 anyway - don't want Helius to retry on our parsing errors
    return success(c, "Webhook acknowledged with errors", { error: String(err) });
  }
});

export { webhooks };
