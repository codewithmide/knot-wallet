import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger as honoLogger } from "hono/logger";
import { readFileSync } from "fs";
import { connect } from "./routes/connect.js";
import { actions } from "./routes/actions.js";
import { policyRoutes } from "./routes/policy.js";
import { tokens } from "./routes/tokens.js";
import { webhooks } from "./routes/webhooks.js";
import { stats } from "./routes/stats.js";
import { predictions } from "./routes/predictions.js";
import { admin } from "./routes/admin/index.js";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { db } from "./db/prisma.js";
import { AppError } from "./utils/errors.js";
import { success, error } from "./utils/response.js";
import { globalIpRateLimit } from "./utils/rate-limit.js";

const app = new Hono();

// Global middleware
app.use("*", cors());
app.use("*", honoLogger());
app.use("*", globalIpRateLimit);

// Serve skill.md — this is how agents discover capabilities
app.get("/skill.md", (c) => {
  try {
    const skill = readFileSync("./public/skill.md", "utf-8");
    return c.text(skill, 200, { "Content-Type": "text/markdown; charset=utf-8" });
  } catch {
    return c.text("skill.md not found", 404);
  }
});

// Health check
app.get("/health", (c) =>
  success(c, "Service is healthy.", {
    timestamp: new Date().toISOString(),
    network: config.SOLANA_NETWORK,
  })
);

// Routes
app.route("/connect", connect);
app.route("/wallets/me", actions);
app.route("/wallets/me/policy", policyRoutes);
app.route("/tokens", tokens);
app.route("/webhooks", webhooks);
app.route("/stats", stats);
app.route("/predictions", predictions);
app.route("/admin", admin);

// 404 handler
app.notFound((c) => error(c, "Resource not found.", 404));

// Error handler
app.onError((err, c) => {
  logger.error("Request error", { error: err.message, stack: err.stack });

  if (err instanceof AppError) {
    return error(c, err.message, err.statusCode, { code: err.code });
  }

  // Zod validation errors
  if (err.name === "ZodError") {
    return error(c, "Validation error.", 400, { details: err });
  }

  // Network/RPC errors from Solana
  if (
    err.message?.includes("fetch failed") ||
    err.message?.includes("ECONNREFUSED") ||
    err.message?.includes("ETIMEDOUT") ||
    err.message?.includes("ENOTFOUND") ||
    err.message?.includes("network request failed") ||
    err.stack?.includes("@solana/web3.js/src/connection")
  ) {
    return error(
      c,
      "Failed to connect to Solana network. This is usually a temporary issue. Please retry your request.",
      503,
      { code: "RPC_CONNECTION_ERROR" }
    );
  }

  // Rate limiting
  if (err.message?.includes("429") || err.message?.includes("Too Many Requests")) {
    return error(
      c,
      "Rate limit exceeded. Please wait a moment and try again.",
      429,
      { code: "RATE_LIMIT_ERROR" }
    );
  }

  return error(c, "Internal server error.", 500);
});

// Start server
const server: ServerType = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  logger.info(`Knot Agent Wallet API running on port ${info.port}`);
  logger.info(`Solana network: ${config.SOLANA_NETWORK}`);
});

// =============================================================================
// Stale OTP Cleanup — runs every 30 minutes
// =============================================================================

const OTP_CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

async function cleanupStaleOtps(): Promise<void> {
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const { count } = await db.otpCode.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: oneHourAgo } },        // expired > 1 hour ago
          { used: true, createdAt: { lt: oneHourAgo } }, // used > 1 hour ago
        ],
      },
    });

    if (count > 0) {
      logger.info("Cleaned up stale OTP codes", { deleted: count });
    }
  } catch (err) {
    logger.error("OTP cleanup failed", { error: String(err) });
  }
}

const otpCleanupTimer = setInterval(cleanupStaleOtps, OTP_CLEANUP_INTERVAL_MS);

// Run once at startup after a short delay
setTimeout(cleanupStaleOtps, 5_000);

// =============================================================================
// Graceful Shutdown
// =============================================================================

let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal}, shutting down gracefully…`);

  // Stop accepting new connections
  clearInterval(otpCleanupTimer);

  server.close(() => {
    logger.info("HTTP server closed");
  });

  // Give in-flight requests a few seconds to finish
  const forceExitTimeout = setTimeout(() => {
    logger.warn("Forcing exit after timeout");
    process.exit(1);
  }, 10_000);

  try {
    await db.$disconnect();
    logger.info("Database disconnected");
  } catch (err) {
    logger.error("Error disconnecting database", { error: String(err) });
  }

  clearTimeout(forceExitTimeout);
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
