import { Hono } from "hono";
import { authRoutes, verifyAdminMiddleware } from "./auth.js";
import { predictionsRoutes } from "./predictions.js";
import { liquidityRoutes } from "./liquidity.js";
import { agentsRoutes } from "./agents.js";
import { transactionsRoutes } from "./transactions.js";
import { dashboardRoutes } from "./dashboard.js";
import { walletRoutes } from "./wallet.js";
import { referralRoutes } from "./referral.js";

const admin = new Hono();

// =============================================================================
// Auth routes (public — no middleware)
// =============================================================================
admin.route("/auth", authRoutes);

// =============================================================================
// Protected routes — require admin authentication
// =============================================================================
admin.use("/predictions/*", verifyAdminMiddleware);
admin.use("/liquidity/*", verifyAdminMiddleware);
admin.use("/agents/*", verifyAdminMiddleware);
admin.use("/agents", verifyAdminMiddleware);
admin.use("/transactions/*", verifyAdminMiddleware);
admin.use("/transactions", verifyAdminMiddleware);
admin.use("/dashboard", verifyAdminMiddleware);
admin.use("/wallet/*", verifyAdminMiddleware);
admin.use("/referral/*", verifyAdminMiddleware);

admin.route("/predictions", predictionsRoutes);
admin.route("/liquidity", liquidityRoutes);
admin.route("/agents", agentsRoutes);
admin.route("/transactions", transactionsRoutes);
admin.route("/dashboard", dashboardRoutes);
admin.route("/wallet", walletRoutes);
admin.route("/referral", referralRoutes);

export { admin };
