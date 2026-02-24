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

  // Stats (private endpoint)
  STATS_API_SECRET: str(),
  STATS_TOKEN_TTL_SECONDS: num({ default: 300 }),

  // Auth
  JWT_SECRET: str(),
  OTP_TTL_MINUTES: num({ default: 10 }),

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
