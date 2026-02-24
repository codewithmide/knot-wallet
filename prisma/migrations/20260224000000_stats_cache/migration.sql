-- Add agent activity tracking
ALTER TABLE "Agent"
  ADD COLUMN IF NOT EXISTS "lastActiveAt" TIMESTAMP NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS "Agent_lastActiveAt_idx"
  ON "Agent" ("lastActiveAt");

-- Stats cache table for fast reads
CREATE TABLE IF NOT EXISTS "StatsCache" (
  "id" TEXT PRIMARY KEY,
  "totalAgents" INTEGER NOT NULL DEFAULT 0,
  "totalTrades" INTEGER NOT NULL DEFAULT 0,
  "totalTradeVolume" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "totalTransfers" INTEGER NOT NULL DEFAULT 0,
  "totalTransferVolume" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "totalDeposits" INTEGER NOT NULL DEFAULT 0,
  "totalDepositVolume" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Ensure supporting indexes exist (safe if already created)
CREATE INDEX IF NOT EXISTS "AuditLog_createdAt_idx"
  ON "AuditLog" ("createdAt");

CREATE INDEX IF NOT EXISTS "AuditLog_action_status_createdAt_idx"
  ON "AuditLog" ("action", "status", "createdAt");
