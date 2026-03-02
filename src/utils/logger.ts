import pino from "pino";

/**
 * Structured JSON logger powered by pino.
 *
 * Wraps pino to maintain the existing call signature used across the codebase:
 *   logger.info("message", { key: value })
 *
 * Pino's native API is (obj, msg) — this adapter flips the arguments so
 * every existing call site continues to work without changes.
 *
 * LOG_LEVEL env var controls verbosity (default: "info").
 * In development, pino-pretty can be piped for human-readable output:
 *   npm run dev | npx pino-pretty
 */

const pinoInstance = pino({
  level: process.env.LOG_LEVEL ?? "info",
  // Use ISO timestamps to match previous logger format
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    // Keep level as string ("info") rather than numeric (30)
    level(label) {
      return { level: label };
    },
  },
});

/**
 * Application logger.
 * Same interface as before: logger.info("message", { optional: "data" })
 */
export const logger = {
  debug: (message: string, data?: Record<string, unknown>) =>
    data ? pinoInstance.debug(data, message) : pinoInstance.debug(message),

  info: (message: string, data?: Record<string, unknown>) =>
    data ? pinoInstance.info(data, message) : pinoInstance.info(message),

  warn: (message: string, data?: Record<string, unknown>) =>
    data ? pinoInstance.warn(data, message) : pinoInstance.warn(message),

  error: (message: string, data?: Record<string, unknown>) =>
    data ? pinoInstance.error(data, message) : pinoInstance.error(message),
};

/** Expose the raw pino instance for advanced use (e.g. child loggers, Hono integration) */
export { pinoInstance };

