import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createDecipheriv } from "crypto";
import { config } from "../../config.js";
import { error, success } from "../../utils/response.js";
import { startAdminOtpFlow, completeAdminOtpFlow, verifyAdminToken } from "../../auth/turnkey-auth.js";
import { logger } from "../../utils/logger.js";
import { AppError } from "../../utils/errors.js";
import { PublicKey } from "@solana/web3.js";

// =============================================================================
// Shared Constants
// =============================================================================

/** USDC mint address (mainnet) — used across admin submodules */
export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

export const ADMIN_SCOPE = "admin";
export const ADMIN_TOKEN_HEADER = "X-Admin-Token";

export interface AdminTokenPayload {
  ts: number;
  scope: string;
}

// =============================================================================
// Crypto Helpers (legacy encrypted token support)
// =============================================================================

function decodeAdminSecret(): Buffer {
  // Use the same secret as stats for simplicity, or create a separate ADMIN_API_SECRET
  const key = Buffer.from(config.STATS_API_SECRET, "base64");
  if (key.length !== 32) {
    throw new Error("STATS_API_SECRET must be a 32-byte base64 string");
  }
  return key;
}

function decryptAdminToken(token: string, key: Buffer): AdminTokenPayload {
  const raw = Buffer.from(token, "base64");
  if (raw.length < 12 + 16) {
    throw new Error("Invalid admin token length");
  }

  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ciphertext = raw.subarray(12, raw.length - 16);

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  const payload = JSON.parse(plaintext.toString("utf-8")) as AdminTokenPayload;
  if (typeof payload.ts !== "number" || typeof payload.scope !== "string") {
    throw new Error("Invalid admin token payload");
  }

  return payload;
}

function verifyLegacyAdminAuth(token: string): string | null {
  try {
    const key = decodeAdminSecret();
    const payload = decryptAdminToken(token, key);

    // Accept both "admin" and "stats" scope for admin endpoints
    if (payload.scope !== ADMIN_SCOPE && payload.scope !== "stats") {
      return "Invalid admin token scope";
    }

    const ageMs = Math.abs(Date.now() - payload.ts);
    if (ageMs > config.STATS_TOKEN_TTL_SECONDS * 1000) {
      return "Admin token expired";
    }

    return null;
  } catch {
    return "Invalid legacy admin token";
  }
}

// =============================================================================
// Admin Auth Middleware
// Supports both JWT tokens (from OTP flow) and legacy encrypted tokens
// =============================================================================

export async function verifyAdminMiddleware(c: any, next: () => Promise<void>) {
  const token = c.req.header(ADMIN_TOKEN_HEADER);

  if (!token) {
    return error(c, "Missing admin token.", 401);
  }

  // Try JWT token first (from email OTP flow)
  try {
    const payload = await verifyAdminToken(token);
    c.set("adminEmail", payload.email);
    return next();
  } catch {
    // JWT verification failed, try legacy encrypted token
  }

  // Try legacy encrypted token
  const legacyError = verifyLegacyAdminAuth(token);
  if (legacyError) {
    return error(c, "Unauthorized admin request.", 401, { reason: legacyError });
  }

  return next();
}

// =============================================================================
// Auth Routes (public — no middleware)
// =============================================================================

const authRoutes = new Hono();

// POST /admin/auth/start
// Admin provides email, server sends OTP (only for whitelisted admin emails)
authRoutes.post(
  "/start",
  zValidator("json", z.object({ email: z.string().email() })),
  async (c) => {
    const { email } = c.req.valid("json");

    logger.info("Admin login start requested", { email });

    try {
      const { otpId } = await startAdminOtpFlow(email);

      return success(c, "OTP sent to your email. Check your inbox.", {
        otpId,
      });
    } catch (err) {
      if (err instanceof AppError) {
        logger.warn("Admin login start failed", { email, error: err.message });
        return error(c, err.message, err.statusCode);
      }

      logger.error("Admin login start failed", { email, error: String(err) });
      return error(c, "Failed to send OTP. Please try again.", 500);
    }
  }
);

// POST /admin/auth/complete
// Admin provides OTP, server verifies and returns admin session token
authRoutes.post(
  "/complete",
  zValidator(
    "json",
    z.object({
      email: z.string().email(),
      otpId: z.string().min(1),
      otpCode: z.string().length(6),
    })
  ),
  async (c) => {
    const { email, otpId, otpCode } = c.req.valid("json");

    logger.info("Admin login complete requested", { email });

    try {
      const result = await completeAdminOtpFlow(email, otpId, otpCode);

      logger.info("Admin authenticated", { email });

      return success(c, "Admin authentication successful.", {
        adminToken: result.adminToken,
        email: result.email,
      });
    } catch (err) {
      logger.error("Admin login complete failed", { email, error: String(err) });

      if (err instanceof AppError) {
        return error(c, err.message, err.statusCode);
      }

      return error(c, "Authentication failed. Please try again.", 500);
    }
  }
);

export { authRoutes };
