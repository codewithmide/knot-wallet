import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { authMiddleware } from "../auth/middleware.js";
import { getAgentPolicy, updateAgentPolicy } from "../policy/engine.js";
import { success } from "../utils/response.js";

import { agentActionRateLimit } from "../utils/rate-limit.js";

const policyRoutes = new Hono();

// All policy routes require authentication, then rate-limit per agent
policyRoutes.use("*", authMiddleware);
policyRoutes.use("*", agentActionRateLimit);

// GET /wallets/me/policy
policyRoutes.get("/", async (c) => {
  const agent = c.get("agent");
  const policy = await getAgentPolicy(agent.id);
  return success(c, "Policy retrieved successfully.", { policy });
});

// PATCH /wallets/me/policy
policyRoutes.patch(
  "/",
  zValidator(
    "json",
    z.object({
      maxSingleTransactionInUsd: z.number().positive().optional(),
      dailyLimitInUsd: z.number().positive().optional(),
      allowedRecipients: z.array(z.string()).optional(),
      allowTrading: z.boolean().optional(),
      allowLiquidityProvision: z.boolean().optional(),
      allowPredictionMarkets: z.boolean().optional(),
      sessionExpirationHours: z.number().int().min(1).max(8760).optional(), // 1 hour to 1 year
    })
  ),
  async (c) => {
    const agent = c.get("agent");
    const updates = c.req.valid("json");

    const policy = await updateAgentPolicy(agent.id, updates);
    return success(c, "Policy updated successfully.", { policy });
  }
);

export { policyRoutes };
