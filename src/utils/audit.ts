import { db } from "../db/prisma.js";
import { Prisma } from "@prisma/client";
import { incrementStatsForAudit } from "./stats-cache.js";
import { logger } from "./logger.js";

export async function createAuditLog(data: {
  agentId?: string | null; // Optional: null for admin actions
  action: string;
  status: string;
  asset?: string | null;
  amount?: number | null;
  from?: string | null;
  to?: string | null;
  signature?: string | null;
  metadata?: Prisma.InputJsonValue;
  normalizedUsdAmount?: number | null;
}) {
  const { normalizedUsdAmount, ...rest } = data;

  // Convert null to undefined for Prisma compatibility (Prisma expects undefined, not null)
  const prismaData = {
    action: rest.action,
    status: rest.status,
    agentId: rest.agentId ?? undefined,
    asset: rest.asset ?? undefined,
    amount: rest.amount ?? undefined,
    from: rest.from ?? undefined,
    to: rest.to ?? undefined,
    signature: rest.signature ?? undefined,
    metadata: rest.metadata,
  };

  const auditLog = await db.auditLog.create({ data: prismaData });

  const promises: Promise<unknown>[] = [
    incrementStatsForAudit(prismaData.action, prismaData.status, prismaData.amount, {
      normalizedUsdAmount,
    }),
  ];

  if (prismaData.agentId) {
    promises.push(
      db.agent.update({
        where: { id: prismaData.agentId },
        data: { lastActiveAt: new Date() },
      })
    );
  }

  await Promise.allSettled(promises).then((results) => {
    for (const result of results) {
      if (result.status === "rejected") {
        logger.warn("Failed to update stats cache", { error: String(result.reason) });
      }
    }
  });

  return auditLog;
}
