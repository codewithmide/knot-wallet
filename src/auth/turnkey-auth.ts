import { turnkeyClient } from "../turnkey/client.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { db } from "../db/prisma.js";
import { AuthenticationError } from "../utils/errors.js";
import { sendOtpEmail } from "../utils/email.js";
import { DEFAULT_POLICY, AgentPolicy } from "../policy/types.js";
import crypto from "crypto";
import jwt from "jsonwebtoken";

// OTP storage (in production, use Redis with TTL)
const otpStore = new Map<string, { code: string; expiresAt: number; email: string }>();

/**
 * Generate a 6-digit OTP code
 */
function generateOtpCode(): string {
  return crypto.randomInt(100000, 999999).toString();
}

/**
 * Start OTP flow - generates OTP and stores it
 * In production, this would send an email via Nodemailer/SendGrid
 * For now, we log the OTP for testing
 */
export async function startOtpFlow(email: string): Promise<{ otpId: string; isNewUser: boolean }> {
  logger.info("Starting OTP flow", { email });

  // Check if user already exists
  const existingAgent = await db.agent.findUnique({ where: { email } });
  const isNewUser = !existingAgent;

  // Generate OTP
  const otpCode = generateOtpCode();
  const otpId = crypto.randomUUID();
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

  // Store OTP
  otpStore.set(otpId, { code: otpCode, expiresAt, email });

  // Send OTP via email
  await sendOtpEmail(email, otpCode);

  logger.info("OTP flow started successfully", { email, otpId, isNewUser });

  return { otpId, isNewUser };
}

/**
 * Complete OTP flow - verify code and create/login user
 * Creates Turnkey sub-organization for new users
 */
export async function completeOtpFlow(
  email: string,
  otpId: string,
  otpCode: string
): Promise<{
  sessionToken: string;
  solanaAddress: string;
  subOrgId: string;
  isNewUser: boolean;
}> {
  logger.info("Completing OTP flow", { email, otpId });

  // Verify OTP
  const storedOtp = otpStore.get(otpId);
  if (!storedOtp) {
    throw new AuthenticationError("OTP not found or expired");
  }

  if (storedOtp.email !== email) {
    throw new AuthenticationError("Email mismatch");
  }

  if (Date.now() > storedOtp.expiresAt) {
    otpStore.delete(otpId);
    throw new AuthenticationError("OTP expired");
  }

  if (storedOtp.code !== otpCode) {
    throw new AuthenticationError("Invalid OTP code");
  }

  // Clear used OTP
  otpStore.delete(otpId);

  // Check if user exists
  let agent = await db.agent.findUnique({ where: { email } });
  const isNewUser = !agent;

  if (!agent) {
    // New user - create Turnkey sub-organization with wallet
    logger.info("Creating new sub-organization for user", { email });

    // Create sub-org with TWO root users:
    // 1. Delegated Access user (our server's API key) - enables server-side signing
    // 2. End user (email only) - the actual wallet owner
    const subOrgResponse = await turnkeyClient.createSubOrganization({
      organizationId: config.TURNKEY_ORGANIZATION_ID,
      subOrganizationName: `Agent - ${email}`,
      rootUsers: [
        {
          // Delegated Access user - allows our server to sign transactions
          userName: "Delegated Server",
          apiKeys: [
            {
              apiKeyName: "Server Signing Key",
              publicKey: config.TURNKEY_DELEGATED_API_PUBLIC_KEY,
              curveType: "API_KEY_CURVE_P256",
            },
          ],
          authenticators: [],
          oauthProviders: [],
        },
        {
          // End user - the actual wallet owner
          userName: email.split("@")[0],
          userEmail: email,
          apiKeys: [],
          authenticators: [],
          oauthProviders: [],
        },
      ],
      rootQuorumThreshold: 1,
      wallet: {
        walletName: "Solana Wallet",
        accounts: [
          {
            curve: "CURVE_ED25519",
            pathFormat: "PATH_FORMAT_BIP32",
            path: "m/44'/501'/0'/0'",
            addressFormat: "ADDRESS_FORMAT_SOLANA",
          },
        ],
      },
    });

    const subOrgId = subOrgResponse.subOrganizationId;
    const walletId = subOrgResponse.wallet?.walletId;
    const solanaAddress = subOrgResponse.wallet?.addresses[0];

    if (!walletId || !solanaAddress) {
      throw new Error("Failed to create wallet in sub-organization");
    }

    // Save agent to database
    agent = await db.agent.create({
      data: {
        email,
        turnkeySubOrgId: subOrgId,
        turnkeyWalletId: walletId,
        solanaAddress,
      },
    });

    logger.info("New user created", { email, subOrgId, solanaAddress });
  }

  // Get agent's policy for session expiration (or use default)
  const agentPolicy = await db.agentPolicy.findUnique({ where: { agentId: agent.id } });
  const policy: AgentPolicy = agentPolicy
    ? (agentPolicy.rules as unknown as AgentPolicy)
    : DEFAULT_POLICY;
  const sessionExpirationHours = policy.sessionExpirationHours ?? DEFAULT_POLICY.sessionExpirationHours;

  // Generate JWT session token
  const sessionToken = jwt.sign(
    {
      agentId: agent.id,
      email: agent.email,
      subOrgId: agent.turnkeySubOrgId,
    },
    config.JWT_SECRET,
    { expiresIn: `${sessionExpirationHours}h` }
  );

  logger.info("OTP verification successful", { email, isNewUser });

  return {
    sessionToken,
    solanaAddress: agent.solanaAddress,
    subOrgId: agent.turnkeySubOrgId,
    isNewUser,
  };
}

/**
 * Verify a session token (JWT)
 * Returns the decoded token payload if valid
 */
export async function verifySessionToken(token: string): Promise<{
  agentId: string;
  email: string;
  subOrgId: string;
}> {
  try {
    const payload = jwt.verify(token, config.JWT_SECRET) as {
      agentId: string;
      email: string;
      subOrgId: string;
    };

    return {
      agentId: payload.agentId,
      email: payload.email,
      subOrgId: payload.subOrgId,
    };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new AuthenticationError("Token expired");
    }
    if (error instanceof jwt.JsonWebTokenError) {
      throw new AuthenticationError("Invalid token");
    }
    throw new AuthenticationError("Token verification failed");
  }
}
