import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { startOtpFlow, completeOtpFlow, verifySessionToken } from "../auth/turnkey-auth.js";
import { logger } from "../utils/logger.js";
import { db } from "../db/prisma.js";
import { DEFAULT_POLICY, AgentPolicy } from "../policy/types.js";
import { config } from "../config.js";
import { success, error } from "../utils/response.js";
import { AppError } from "../utils/errors.js";
import jwt from "jsonwebtoken";

const connect = new Hono();

// POST /connect/start
// Agent provides email, server generates OTP and sends via email (Nodemailer)
connect.post(
  "/start",
  zValidator("json", z.object({ email: z.string().email() })),
  async (c) => {
    const { email } = c.req.valid("json");
    const startedAt = Date.now();

    logger.info("Connection start requested", { email });

    try {
      const { otpId, isNewUser } = await startOtpFlow(email);

      logger.info("Connection start completed", {
        email,
        otpId,
        isNewUser,
        durationMs: Date.now() - startedAt,
      });

      return success(c, "OTP sent to your email. Check your inbox.", {
        otpId,
        isNewUser,
      });
    } catch (err) {
      const errorMessage = String(err);

      if (err instanceof AppError) {
        logger.error("Failed to start OTP flow", {
          email,
          error: errorMessage,
          durationMs: Date.now() - startedAt,
          probableCause: err.code ?? "app_error",
        });
        return error(c, err.message, err.statusCode, { code: err.code });
      }

      logger.error("Failed to start OTP flow", {
        email,
        error: errorMessage,
        durationMs: Date.now() - startedAt,
        probableCause: errorMessage.includes("Operation has timed out")
          ? "database_timeout"
          : "unknown",
      });
      return error(c, "Failed to send OTP. Please try again.", 500);
    }
  }
);

// POST /connect/complete
// Agent provides OTP, server verifies and returns session token
connect.post(
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

    logger.info("Connection complete requested", { email });

    try {
      const result = await completeOtpFlow(email, otpId, otpCode);

      logger.info("Agent authenticated", {
        email,
        isNewUser: result.isNewUser,
        solanaAddress: result.solanaAddress,
      });

      return success(c, "Authentication successful.", {
        sessionToken: result.sessionToken,
        solanaAddress: result.solanaAddress,
        isNewUser: result.isNewUser,
      });
    } catch (err) {
      logger.error("Failed to complete OTP flow", { email, error: String(err) });

      // Handle AppError types (AuthenticationError, ValidationError, etc.)
      if (err instanceof AppError) {
        return error(c, err.message, err.statusCode);
      }

      return error(c, "Authentication failed. Please try again.", 500);
    }
  }
);

// POST /connect/validate
// Check if current session token is still valid
connect.post("/validate", async (c) => {
  const authHeader = c.req.header("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return error(c, "No token provided.", 401);
  }

  const token = authHeader.slice(7);

  try {
    const payload = await verifySessionToken(token);
    const agent = await db.agent.findUnique({ where: { id: payload.agentId } });

    if (!agent) {
      return error(c, "Agent not found.", 401);
    }

    // Decode token to get expiration info
    const decoded = jwt.decode(token) as { exp?: number };
    const expiresAt = decoded?.exp ? new Date(decoded.exp * 1000).toISOString() : null;

    return success(c, "Token is valid.", {
      valid: true,
      email: agent.email,
      solanaAddress: agent.solanaAddress,
      expiresAt,
    });
  } catch (err) {
    logger.debug("Token validation failed", { error: String(err) });
    return error(c, "Token expired or invalid.", 401);
  }
});

// POST /connect/refresh
// Issue a new session token if the current one is still valid
connect.post("/refresh", async (c) => {
  const authHeader = c.req.header("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return error(c, "No token provided.", 401);
  }

  const token = authHeader.slice(7);

  try {
    const payload = await verifySessionToken(token);
    const agent = await db.agent.findUnique({ where: { id: payload.agentId } }) as {
      id: string;
      email: string;
      solanaAddress: string;
      turnkeySubOrgId: string;
    } | null;

    if (!agent) {
      return error(c, "Agent not found.", 401);
    }

    // Get agent's policy for session expiration
    const agentPolicy = await db.agentPolicy.findUnique({ where: { agentId: agent.id } });
    const policy: AgentPolicy = agentPolicy
      ? (agentPolicy.rules as unknown as AgentPolicy)
      : DEFAULT_POLICY;
    const sessionExpirationHours = policy.sessionExpirationHours ?? DEFAULT_POLICY.sessionExpirationHours;

    // Generate new JWT session token
    const newSessionToken = jwt.sign(
      {
        agentId: agent.id,
        email: agent.email,
        subOrgId: agent.turnkeySubOrgId,
      },
      config.JWT_SECRET,
      { expiresIn: `${sessionExpirationHours}h` }
    );

    logger.info("Session refreshed", { email: agent.email });

    return success(c, "Session refreshed successfully.", {
      sessionToken: newSessionToken,
      solanaAddress: agent.solanaAddress,
      email: agent.email,
    });
  } catch (err) {
    logger.debug("Token refresh failed", { error: String(err) });
    return error(c, "Token expired or invalid. Please sign in again.", 401);
  }
});

export { connect };
