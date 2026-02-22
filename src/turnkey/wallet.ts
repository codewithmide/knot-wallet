import { turnkeyClient } from "./client.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

export interface ProvisionedWallet {
  walletId: string;
  solanaAddress: string;
}

/**
 * Creates a new Solana wallet in Turnkey for an agent.
 * Called once during agent registration.
 */
export async function provisionAgentWallet(
  agentId: string
): Promise<ProvisionedWallet> {
  logger.info("Provisioning new wallet for agent", { agentId });

  const response = await turnkeyClient.createWallet({
    organizationId: config.TURNKEY_ORGANIZATION_ID,
    walletName: `agent-${agentId}-${Date.now()}`,
    accounts: [
      {
        curve: "CURVE_ED25519",
        pathFormat: "PATH_FORMAT_BIP32",
        path: "m/44'/501'/0'/0'",
        addressFormat: "ADDRESS_FORMAT_SOLANA",
      },
    ],
  });

  const walletId = response.walletId;
  const solanaAddress = response.addresses[0];

  logger.info("Wallet provisioned successfully", { walletId, solanaAddress });

  return { walletId, solanaAddress };
}

/**
 * Fetches the Solana address for an existing wallet from Turnkey.
 */
export async function getAgentWallet(walletId: string): Promise<string> {
  const response = await turnkeyClient.getWalletAccounts({
    organizationId: config.TURNKEY_ORGANIZATION_ID,
    walletId,
  });

  const solanaAccount = response.accounts.find(
    (a) => a.addressFormat === "ADDRESS_FORMAT_SOLANA"
  );

  if (!solanaAccount) {
    throw new Error("No Solana account found for wallet");
  }

  return solanaAccount.address;
}
