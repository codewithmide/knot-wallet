import { Context, Next } from "hono";
import { verifySessionToken } from "./turnkey-auth.js";
import { db } from "../db/prisma.js";
import { AuthenticationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

// Extend Hono context to include agent
declare module "hono" {
  interface ContextVariableMap {
    agent: {
      id: string;
      email: string;
      username: string;
      solanaAddress: string;
      turnkeyWalletId: string;
      turnkeySubOrgId: string;
    };
  }
}

/**
 * Authentication middleware.
 * Verifies the Turnkey session token and attaches the agent to the context.
 */
export async function authMiddleware(c: Context, next: Next): Promise<Response | void> {
  const authHeader = c.req.header("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new AuthenticationError("Missing or invalid Authorization header");
  }

  const token = authHeader.slice(7); // Remove "Bearer " prefix

  try {
    const payload = await verifySessionToken(token);

    // Find agent by ID (from our JWT token)
    const agent = await db.agent.findUnique({
      where: { id: payload.agentId },
    });

    if (!agent) {
      throw new AuthenticationError("Agent not found");
    }

    // Attach agent to context
    c.set("agent", {
      id: agent.id,
      email: agent.email,
      username: agent.username,
      solanaAddress: agent.solanaAddress,
      turnkeyWalletId: agent.turnkeyWalletId,
      turnkeySubOrgId: agent.turnkeySubOrgId,
    });

    logger.debug("Agent authenticated", { agentId: agent.id });

    await next();
  } catch (error) {
    if (error instanceof AuthenticationError) {
      throw error;
    }
    logger.warn("Token verification failed", { error: String(error) });
    throw new AuthenticationError("Invalid or expired token");
  }
}
