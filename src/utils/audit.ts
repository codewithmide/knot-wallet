import { db } from "../db/prisma.js";
import { Prisma } from "@prisma/client";
import { incrementStatsForAudit } from "./stats-cache.js";
import { logger } from "./logger.js";

export async function createAuditLog(data: {
  agentId: string;
  action: string;
  status: string;
  asset?: string | null;
  amount?: number | null;
  from?: string | null;
  to?: string | null;
  signature?: string | null;
  metadata?: Prisma.InputJsonValue;
}) {
  const auditLog = await db.auditLog.create({ data });

  await Promise.allSettled([
    db.agent.update({
      where: { id: data.agentId },
      data: { lastActiveAt: new Date() },
    }),
    incrementStatsForAudit(data.action, data.status, data.amount),
  ]).then((results) => {
    for (const result of results) {
      if (result.status === "rejected") {
        logger.warn("Failed to update stats cache", { error: String(result.reason) });
      }
    }
  });

  return auditLog;
}
