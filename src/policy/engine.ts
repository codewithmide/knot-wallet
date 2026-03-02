import { db } from "../db/prisma.js";
import { DEFAULT_POLICY, AgentPolicy } from "./types.js";
import { PolicyError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

export interface PolicyRequest {
  type: "transfer" | "trade" | "add_liquidity" | "remove_liquidity" | "prediction_market";
  usdValue: number;                // USD value of the operation (REQUIRED for all operations)
  to?: string;                     // Recipient address (for transfers only)
  // Original fields kept for logging/audit
  asset?: "sol" | "usdc" | "spl";
  amount?: number;
  mint?: string;
  fromMint?: string;
  toMint?: string;
  pool?: string;
  position?: string;
  amountX?: number;
  amountY?: number;
  percentage?: number;
  action?: string;
  ticker?: string;
  side?: "yes" | "no";
  orderAction?: "buy" | "sell";
  count?: number;
  price?: number;
}

/**
 * Check if a request is allowed by the agent's policy.
 * Throws PolicyError if the request violates any policy rules.
 * IMPORTANT: This MUST be called BEFORE any transaction is signed or API request is made.
 */
export async function checkPolicy(
  agentId: string,
  request: PolicyRequest
): Promise<void> {
  const agentPolicy = await db.agentPolicy.findUnique({ where: { agentId } });
  const policy: AgentPolicy = agentPolicy
    ? (agentPolicy.rules as unknown as AgentPolicy)
    : DEFAULT_POLICY;

  logger.info("Checking policy", { agentId, requestType: request.type, usdValue: request.usdValue });

  // 1. Feature enable/disable checks (fail fast)
  if (request.type === "trade" && !policy.allowTrading) {
    throw new PolicyError("Trading is not enabled for this agent.");
  }

  if ((request.type === "add_liquidity" || request.type === "remove_liquidity") && !policy.allowLiquidityProvision) {
    throw new PolicyError("Liquidity provision is not enabled for this agent.");
  }

  if (request.type === "prediction_market" && !policy.allowPredictionMarkets) {
    throw new PolicyError("Prediction market trading is not enabled for this agent.");
  }

  // 2. Recipient whitelist check (transfers only)
  if (request.type === "transfer" && policy.allowedRecipients.length > 0 && request.to) {
    if (!policy.allowedRecipients.includes(request.to)) {
      throw new PolicyError(
        `Recipient ${request.to} is not in your allowed recipients list.`
      );
    }
  }

  // 3. Per-transaction USD limit (skip for remove_liquidity — users can always withdraw)
  if (request.type !== "remove_liquidity" && request.usdValue > policy.maxSingleTransactionInUsd) {
    throw new PolicyError(
      `Transaction value of $${request.usdValue.toFixed(2)} exceeds single transaction limit of $${policy.maxSingleTransactionInUsd}.`
    );
  }

  // 4. Daily USD limit (skip for remove_liquidity — withdrawals are inbound, not outbound)
  if (request.type !== "remove_liquidity") {
    const dailySpentUsd = await getDailySpentUsd(agentId);

    if (dailySpentUsd + request.usdValue > policy.dailyLimitInUsd) {
      throw new PolicyError(
        `Transaction would exceed daily USD limit of $${policy.dailyLimitInUsd}. ` +
        `Already spent: $${dailySpentUsd.toFixed(2)} today. ` +
        `Attempting to spend: $${request.usdValue.toFixed(2)}.`
      );
    }
  }

  logger.info("Policy check passed", { agentId, requestType: request.type, usdValue: request.usdValue });
}

/**
 * Get the total USD value spent by an agent in the last 24 hours across ALL operations.
 * Includes: transfers, trades, LP deposits, prediction market deposits.
 */
async function getDailySpentUsd(agentId: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Get all confirmed outbound operations in the last 24 hours
  const logs = await db.auditLog.findMany({
    where: {
      agentId,
      status: "confirmed",
      createdAt: { gte: since },
      action: {
        in: [
          "transfer_sol",
          "transfer_spl",
          "trade",
          "add_liquidity",
          "prediction_buy",
          "prediction_withdrawal",
        ],
      },
    },
    select: {
      metadata: true,
    },
  });

  // Sum up usdValue from metadata
  const totalUsd = logs.reduce((sum, log) => {
    const metadata = log.metadata as any;
    const usdValue = metadata?.usdValue ?? 0;
    return sum + usdValue;
  }, 0);

  return totalUsd;
}

/**
 * Get an agent's current policy (or default if none set).
 */
export async function getAgentPolicy(agentId: string): Promise<AgentPolicy> {
  const agentPolicy = await db.agentPolicy.findUnique({ where: { agentId } });
  return agentPolicy ? (agentPolicy.rules as unknown as AgentPolicy) : DEFAULT_POLICY;
}

/**
 * Update an agent's policy with partial updates.
 */
export async function updateAgentPolicy(
  agentId: string,
  updates: Partial<AgentPolicy>
): Promise<AgentPolicy> {
  const currentPolicy = await getAgentPolicy(agentId);
  const newPolicy = { ...currentPolicy, ...updates };

  await db.agentPolicy.upsert({
    where: { agentId },
    update: { rules: newPolicy },
    create: { agentId, rules: newPolicy },
  });

  logger.info("Policy updated", { agentId, updates });

  return newPolicy;
}
