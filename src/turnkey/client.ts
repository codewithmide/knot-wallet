import { Turnkey } from "@turnkey/sdk-server";
import { config } from "../config.js";

/**
 * Parent organization client — used for:
 * - Creating sub-organizations
 * - Reading data from sub-orgs (read access only)
 * - Export operations
 *
 * This client CANNOT sign transactions in sub-orgs.
 */
export const turnkeyClient = new Turnkey({
  apiBaseUrl: "https://api.turnkey.com",
  apiPublicKey: config.TURNKEY_API_PUBLIC_KEY,
  apiPrivateKey: config.TURNKEY_API_PRIVATE_KEY,
  defaultOrganizationId: config.TURNKEY_ORGANIZATION_ID,
}).apiClient();

/**
 * Delegated signing client — used for:
 * - Signing transactions in sub-orgs
 * - Any write operations in sub-orgs
 *
 * This client uses API keys that are added as root users in each sub-org,
 * allowing server-side signing without user interaction.
 */
export const turnkeyDelegatedClient = new Turnkey({
  apiBaseUrl: "https://api.turnkey.com",
  apiPublicKey: config.TURNKEY_DELEGATED_API_PUBLIC_KEY,
  apiPrivateKey: config.TURNKEY_DELEGATED_API_PRIVATE_KEY,
  defaultOrganizationId: config.TURNKEY_ORGANIZATION_ID,
}).apiClient();
