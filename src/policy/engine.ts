import { db } from "../db/prisma.js";
import { DEFAULT_POLICY, AgentPolicy } from "./types.js";
import { PolicyError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

export interface PolicyRequest {
  type: "transfer" | "trade" | "external_sign";
  asset?: "sol" | "usdc" | "spl"; // "spl" for other SPL tokens
  amount?: number;
  to?: string;
  mint?: string; // mint address for SPL tokens
  fromMint?: string;
  toMint?: string;
  logs?: string[] | null;
}

/**
 * Check if a request is allowed by the agent's policy.
 * Throws PolicyError if the request violates any policy rules.
 */
export async function checkPolicy(
  agentId: string,
  request: PolicyRequest
): Promise<void> {
  const agentPolicy = await db.agentPolicy.findUnique({ where: { agentId } });
  const policy: AgentPolicy = agentPolicy
    ? (agentPolicy.rules as unknown as AgentPolicy)
    : DEFAULT_POLICY;

  logger.debug("Checking policy", { agentId, request, policy });

  // External signing check
  if (request.type === "external_sign" && !policy.allowExternalSigning) {
    throw new PolicyError(
      "External transaction signing is not enabled for this agent. " +
      "Update your policy to enable it."
    );
  }

  // Trading check
  if (request.type === "trade" && !policy.allowTrading) {
    throw new PolicyError("Trading is not enabled for this agent.");
  }

  // Transfer checks
  if (request.type === "transfer" && request.amount !== undefined) {
    const { asset, amount, to } = request;

    // Recipient whitelist (if configured)
    if (policy.allowedRecipients.length > 0 && to) {
      if (!policy.allowedRecipients.includes(to)) {
        throw new PolicyError(
          `Recipient ${to} is not in your allowed recipients list.`
        );
      }
    }

    // Per-transaction limits
    if (asset === "sol" && amount > policy.maxSingleTransferSol) {
      throw new PolicyError(
        `Transfer of ${amount} SOL exceeds single transfer limit ` +
        `of ${policy.maxSingleTransferSol} SOL.`
      );
    }
    if (asset === "usdc" && amount > policy.maxSingleTransferUsdc) {
      throw new PolicyError(
        `Transfer of ${amount} USDC exceeds single transfer limit ` +
        `of ${policy.maxSingleTransferUsdc} USDC.`
      );
    }

    // Daily rolling limit (read from audit log)
    const dailySpent = await getDailySpent(agentId, asset!);

    if (asset === "sol" && dailySpent + amount > policy.dailyLimitSol) {
      throw new PolicyError(
        `Transfer would exceed daily SOL limit of ${policy.dailyLimitSol}. ` +
        `Already spent: ${dailySpent} SOL today.`
      );
    }
    if (asset === "usdc" && dailySpent + amount > policy.dailyLimitUsdc) {
      throw new PolicyError(
        `Transfer would exceed daily USDC limit of ${policy.dailyLimitUsdc}. ` +
        `Already spent: ${dailySpent} USDC today.`
      );
    }
  }

  logger.debug("Policy check passed", { agentId, request });
}

/**
 * Get the total amount spent by an agent in the last 24 hours for a given asset.
 */
async function getDailySpent(agentId: string, asset: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const result = await db.auditLog.aggregate({
    where: {
      agentId,
      asset,
      status: "confirmed",
      createdAt: { gte: since },
    },
    _sum: { amount: true },
  });
  return result._sum.amount ?? 0;
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
