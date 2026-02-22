import { turnkeyClient } from "../turnkey/client.js";
import { generateP256KeyPair, decryptExportBundle } from "@turnkey/crypto";
import { logger } from "../utils/logger.js";

/**
 * Export wallet private key
 *
 * This exports the Solana private key for the given address.
 * The key is encrypted by Turnkey and decrypted server-side.
 *
 * WARNING: This returns the raw private key. In production,
 * consider returning an encrypted bundle that only the user can decrypt.
 */
export async function exportWalletPrivateKey(
  solanaAddress: string,
  subOrgId: string
): Promise<{
  privateKey: string;
  address: string;
}> {
  logger.info("Exporting wallet private key", { address: solanaAddress });

  // Generate a temporary key pair for encryption
  const keyPair = generateP256KeyPair();

  // Export the wallet account (private key for this address)
  const exportResult = await turnkeyClient.exportWalletAccount({
    address: solanaAddress,
    targetPublicKey: keyPair.publicKeyUncompressed,
    organizationId: subOrgId,
  });

  const exportBundle = exportResult.exportBundle;

  if (!exportBundle) {
    throw new Error("Failed to export wallet - no bundle returned");
  }

  // Decrypt the export bundle using our private key
  const decryptedKey = await decryptExportBundle({
    exportBundle,
    embeddedKey: keyPair.privateKey,
    organizationId: subOrgId,
    returnMnemonic: false, // We want the raw key, not mnemonic
  });

  logger.info("Wallet private key exported successfully", { address: solanaAddress });

  return {
    privateKey: decryptedKey,
    address: solanaAddress,
  };
}

/**
 * Export wallet seed phrase (mnemonic)
 *
 * This exports the wallet's seed phrase which can be used to recover
 * the wallet in any compatible wallet app.
 */
export async function exportWalletSeedPhrase(
  walletId: string,
  subOrgId: string
): Promise<{
  seedPhrase: string;
}> {
  logger.info("Exporting wallet seed phrase", { walletId });

  // Generate a temporary key pair for encryption
  const keyPair = generateP256KeyPair();

  // Export the wallet (seed phrase)
  const exportResult = await turnkeyClient.exportWallet({
    walletId,
    targetPublicKey: keyPair.publicKeyUncompressed,
    organizationId: subOrgId,
  });

  const exportBundle = exportResult.exportBundle;

  if (!exportBundle) {
    throw new Error("Failed to export wallet - no bundle returned");
  }

  // Decrypt the export bundle using our private key
  const decryptedSeedPhrase = await decryptExportBundle({
    exportBundle,
    embeddedKey: keyPair.privateKey,
    organizationId: subOrgId,
    returnMnemonic: true,
  });

  logger.info("Wallet seed phrase exported successfully", { walletId });

  return {
    seedPhrase: decryptedSeedPhrase,
  };
}
