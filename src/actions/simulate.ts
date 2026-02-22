import { VersionedTransaction } from "@solana/web3.js";
import { simulateTransaction, signAndBroadcast } from "../turnkey/signer.js";
import { checkPolicy } from "../policy/engine.js";
import { db } from "../db/prisma.js";
import { logger } from "../utils/logger.js";
import { TransactionError } from "../utils/errors.js";

/**
 * Sign and broadcast a transaction that was handed to the agent
 * by an external protocol (e.g., a dApp integration).
 *
 * ALWAYS simulates first to understand what the transaction does.
 * This protects against prompt injection attacks.
 */
export async function signExternalTransaction(
  serializedTx: string,
  signerAddress: string,
  agentId: string,
  subOrgId: string
): Promise<{ signature: string; explorerUrl: string }> {
  logger.info("Processing external transaction", { agentId, signerAddress });

  // Deserialize
  const txBytes = Buffer.from(serializedTx, "base64");
  const transaction = VersionedTransaction.deserialize(txBytes);

  // CRITICAL: Simulate before signing anything from an external source
  const simulation = await simulateTransaction(transaction);

  if (!simulation.success) {
    throw new TransactionError(
      `Transaction simulation failed: ${simulation.error}\n` +
        `Logs: ${simulation.logs?.join("\n")}`
    );
  }

  // Analyze simulation logs for suspicious patterns
  const suspicious = analyzeLogs(simulation.logs);
  if (suspicious.detected) {
    logger.warn("Suspicious transaction detected", {
      agentId,
      reason: suspicious.reason,
    });

    await db.auditLog.create({
      data: {
        agentId,
        action: "external_sign",
        status: "rejected_by_policy",
        metadata: {
          reason: suspicious.reason,
          logs: simulation.logs,
        },
      },
    });

    throw new TransactionError(
      `Transaction flagged as potentially unsafe: ${suspicious.reason}`
    );
  }

  // Policy check on the parsed transaction
  await checkPolicy(agentId, { type: "external_sign", logs: simulation.logs });

  let signature: string;

  try {
    signature = await signAndBroadcast(transaction, signerAddress, subOrgId);
  } catch (error) {
    await db.auditLog.create({
      data: {
        agentId,
        action: "external_sign",
        status: "failed",
        metadata: { error: String(error) },
      },
    });
    throw error;
  }

  await db.auditLog.create({
    data: {
      agentId,
      action: "external_sign",
      signature,
      status: "confirmed",
      metadata: { logs: simulation.logs },
    },
  });

  logger.info("External transaction signed and broadcast", {
    signature,
    agentId,
  });

  return {
    signature,
    explorerUrl: `https://solscan.io/tx/${signature}`,
  };
}

function analyzeLogs(
  logs: string[] | null
): { detected: boolean; reason?: string } {
  if (!logs) return { detected: false };

  // Flag instructions that transfer ownership or drain accounts
  const dangerPatterns = [
    { pattern: "SetAuthority", reason: "Attempts to transfer account ownership" },
    { pattern: "CloseAccount", reason: "Attempts to close and drain an account" },
    { pattern: "InitializeMint", reason: "Unexpected mint initialization" },
  ];

  for (const { pattern, reason } of dangerPatterns) {
    if (logs.some((log) => log.includes(pattern))) {
      return { detected: true, reason };
    }
  }

  return { detected: false };
}
