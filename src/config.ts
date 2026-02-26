import { cleanEnv, str, port, num } from "envalid";
import "dotenv/config";

export const config = cleanEnv(process.env, {
  // Turnkey - Parent org credentials (for read operations and sub-org creation)
  TURNKEY_API_PUBLIC_KEY: str(),
  TURNKEY_API_PRIVATE_KEY: str(),
  TURNKEY_ORGANIZATION_ID: str(),

  // Turnkey - Delegated signing credentials (for signing in sub-orgs)
  // These are added as root users in each sub-org to enable server-side signing
  TURNKEY_DELEGATED_API_PUBLIC_KEY: str(),
  TURNKEY_DELEGATED_API_PRIVATE_KEY: str(),

  // Solana
  HELIUS_API_KEY: str(),
  SOLANA_NETWORK: str({ choices: ["mainnet-beta", "devnet"], default: "mainnet-beta" }),
  SOLANA_RPC_URL: str({ default: "" }),

  // Helius Webhooks
  HELIUS_WEBHOOK_SECRET: str(),

  // Jupiter
  JUPITER_API_KEY: str(),

  // Kalshi Prediction Markets
  KALSHI_API_KEY_ID: str({ default: "" }),
  KALSHI_RSA_PRIVATE_KEY: str({ default: "" }),
  KALSHI_API_BASE_URL: str({ default: "https://api.elections.kalshi.com/trade-api/v2" }),

  // Kalshi Admin Wallet (for custodial prediction market funds)
  // This wallet holds all agent prediction funds - address is NOT exposed to agents
  KNOT_KALSHI_ADMIN_KEY_ID: str({ default: "" }),  // Turnkey sub-org ID for admin wallet
  KNOT_KALSHI_ADMIN_WALLET_ADDRESS: str({ default: "" }),  // Solana address of admin wallet

  // Meteora Admin Wallet (for custodial liquidity provision)
  // This wallet provides liquidity on behalf of agents - address is NOT exposed to agents
  KNOT_METEORA_ADMIN_KEY_ID: str({ default: "" }),  // Turnkey sub-org ID for admin wallet
  KNOT_METEORA_ADMIN_WALLET_ADDRESS: str({ default: "" }),  // Solana address of admin wallet

  // Fee Collection Wallet (receives platform fees from transfers/trades)
  // This is where 1% + flat fee goes for all non-custodial transactions
  KNOT_FEE_WALLET_ADDRESS: str({ default: "" }),  // Solana address for fee collection

  // Stats (private endpoint)
  STATS_API_SECRET: str(),
  STATS_TOKEN_TTL_SECONDS: num({ default: 300 }),

  // Auth
  JWT_SECRET: str(),
  OTP_TTL_MINUTES: num({ default: 10 }),

  // Admin emails (comma-separated list of authorized admin emails)
  ADMIN_EMAILS: str({ default: "codewithmide@gmail.com" }),

  // Email
  MAILTRAP_API_KEY: str(),
  SMTP_HOST: str({ default: "" }),
  SMTP_PORT: port({ default: 587 }),
  SMTP_USERNAME: str({ default: "" }),
  SMTP_PASS: str({ default: "" }),

  // Database
  DATABASE_URL: str(),

  // Server
  PORT: port({ default: 3000 }),
  API_BASE_URL: str({ default: "http://localhost:3000" }),
});

// Construct RPC URL if not provided
export const getSolanaRpcUrl = (): string => {
  if (config.SOLANA_RPC_URL) {
    return config.SOLANA_RPC_URL;
  }
  const network = config.SOLANA_NETWORK === "devnet" ? "devnet" : "mainnet";
  return `https://${network}.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`;
};

// Check if email is an authorized admin
export const isAdminEmail = (email: string): boolean => {
  const adminEmails = config.ADMIN_EMAILS.split(",").map((e) => e.trim().toLowerCase());
  return adminEmails.includes(email.toLowerCase());
};
