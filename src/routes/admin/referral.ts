import { Hono } from "hono";
import { config } from "../../config.js";
import { error, success } from "../../utils/response.js";
import { connection, signAndBroadcastAdmin } from "../../turnkey/signer.js";
import { PublicKey } from "@solana/web3.js";
import {
  getMint,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { ReferralProvider } from "@jup-ag/referral-sdk";
import { createAuditLog } from "../../utils/audit.js";
import { logger } from "../../utils/logger.js";

const referralRoutes = new Hono();

// SOL mint address (wrapped SOL)
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

// =============================================================================
// Referral Status
// =============================================================================

// GET /referral/status
referralRoutes.get("/status", async (c) => {
  try {
    const referralAccountAddress = config.JUPITER_REFERRAL_ACCOUNT;
    const feeWalletAddress = config.KNOT_FEE_WALLET_ADDRESS;

    if (!referralAccountAddress) {
      return error(c, "Jupiter referral account not configured. Set JUPITER_REFERRAL_ACCOUNT in env.", 503);
    }

    logger.info("Checking Jupiter referral status", { referralAccountAddress });

    // Initialize the ReferralProvider
    const provider = new ReferralProvider(connection);

    // Get all referral token accounts (where fees accumulate)
    const { tokenAccounts, token2022Accounts } = await provider.getReferralTokenAccounts(referralAccountAddress);
    const allTokenAccounts = [...tokenAccounts, ...token2022Accounts];

    logger.info("Found referral token accounts", {
      tokenAccounts: tokenAccounts.length,
      token2022Accounts: token2022Accounts.length
    });

    // Collect unclaimed balances
    const unclaimedFees: {
      mint: string;
      symbol: string;
      amount: number;
      amountRaw: string;
      decimals: number;
      isToken2022: boolean;
    }[] = [];

    // Known mints for display
    const knownMints: Record<string, { symbol: string; decimals: number }> = {
      "So11111111111111111111111111111111111111112": { symbol: "SOL", decimals: 9 },
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": { symbol: "USDC", decimals: 6 },
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": { symbol: "USDT", decimals: 6 },
    };

    for (let i = 0; i < allTokenAccounts.length; i++) {
      const tokenAccount = allTokenAccounts[i];
      const isToken2022 = i >= tokenAccounts.length;
      const mintStr = tokenAccount.account.mint.toBase58();
      const amountRaw = tokenAccount.account.amount;

      // Skip if no balance
      if (amountRaw === BigInt(0)) continue;

      let symbol = "UNKNOWN";
      let decimals = 9; // Default to SOL decimals

      if (knownMints[mintStr]) {
        symbol = knownMints[mintStr].symbol;
        decimals = knownMints[mintStr].decimals;
      } else {
        // Try to fetch mint info
        try {
          const mintPubkey = tokenAccount.account.mint;
          const mintInfo = await getMint(
            connection,
            mintPubkey,
            undefined,
            isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
          );
          decimals = mintInfo.decimals;
        } catch {
          // Keep default
        }
      }

      const amount = Number(amountRaw) / Math.pow(10, decimals);

      unclaimedFees.push({
        mint: mintStr,
        symbol,
        amount,
        amountRaw: amountRaw.toString(),
        decimals,
        isToken2022,
      });
    }

    return success(c, "Jupiter referral status retrieved.", {
      referralAccount: {
        address: referralAccountAddress,
        feeTiers: {
          description: "Tiered fees based on trade USD value",
          tiers: [
            { range: "< $6.25", bps: 255, net: "2.04%" },
            { range: "$6.25-$12.50", bps: 200, net: "1.60%" },
            { range: "≥ $12.50", bps: 100, net: "0.80%" },
          ],
        },
      },
      feeWallet: feeWalletAddress || "not configured",
      tokenAccountsCount: allTokenAccounts.length,
      unclaimedFees,
      totalUnclaimedTokens: unclaimedFees.length,
    });
  } catch (err) {
    logger.error("Failed to check referral status", { error: String(err) });
    return error(c, `Failed to check referral status: ${String(err)}`, 500);
  }
});

// =============================================================================
// Claim Referral Fees
// =============================================================================

// POST /referral/claim
referralRoutes.post("/claim", async (c) => {
  const adminEmail = (c.get as (key: string) => string | undefined)("adminEmail") || "unknown";

  try {
    const referralAccountAddress = config.JUPITER_REFERRAL_ACCOUNT;
    const feeWalletAddress = config.KNOT_FEE_WALLET_ADDRESS;

    if (!referralAccountAddress) {
      return error(c, "Jupiter referral account not configured. Set JUPITER_REFERRAL_ACCOUNT in env.", 503);
    }

    if (!feeWalletAddress) {
      return error(c, "Fee wallet not configured. Set KNOT_FEE_WALLET_ADDRESS in env.", 503);
    }

    logger.info("Starting Jupiter referral fee claim", { referralAccountAddress, feeWalletAddress, adminEmail });

    const referralAccountPubkey = new PublicKey(referralAccountAddress);
    const feeWalletPubkey = new PublicKey(feeWalletAddress);

    // Initialize the ReferralProvider
    const provider = new ReferralProvider(connection);

    // Get all referral token accounts
    const { tokenAccounts, token2022Accounts } = await provider.getReferralTokenAccounts(referralAccountAddress);
    const allTokenAccounts = [...tokenAccounts, ...token2022Accounts];

    if (allTokenAccounts.length === 0) {
      return success(c, "No referral token accounts found. Nothing to claim.", {
        claimed: [],
        totalClaimed: 0,
      });
    }

    // Filter to only accounts with balance
    const accountsWithBalance = allTokenAccounts.filter(
      (ta) => ta.account.amount > BigInt(0)
    );

    if (accountsWithBalance.length === 0) {
      return success(c, "All referral token accounts are empty. Nothing to claim.", {
        claimed: [],
        totalClaimed: 0,
      });
    }

    logger.info("Found accounts with balance to claim", { count: accountsWithBalance.length });

    const claimedFees: {
      mint: string;
      symbol: string;
      amount: number;
      signature: string;
    }[] = [];

    // Known mints for display
    const knownMints: Record<string, { symbol: string; decimals: number }> = {
      "So11111111111111111111111111111111111111112": { symbol: "SOL", decimals: 9 },
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": { symbol: "USDC", decimals: 6 },
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": { symbol: "USDT", decimals: 6 },
    };

    // Get claim transactions for each token
    for (let i = 0; i < accountsWithBalance.length; i++) {
      const tokenAccount = accountsWithBalance[i];
      const isToken2022 = i >= tokenAccounts.filter((ta) => ta.account.amount > BigInt(0)).length;
      const mintStr = tokenAccount.account.mint.toBase58();
      const amountRaw = tokenAccount.account.amount;

      let symbol = "UNKNOWN";
      let decimals = 9;

      if (knownMints[mintStr]) {
        symbol = knownMints[mintStr].symbol;
        decimals = knownMints[mintStr].decimals;
      } else {
        try {
          const mintInfo = await getMint(
            connection,
            tokenAccount.account.mint,
            undefined,
            isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
          );
          decimals = mintInfo.decimals;
        } catch {
          // Keep default
        }
      }

      const amount = Number(amountRaw) / Math.pow(10, decimals);

      try {
        // Build claim transaction using the SDK
        const claimTx = isToken2022
          ? await provider.claimV2({
              payerPubKey: feeWalletPubkey,
              referralAccountPubKey: referralAccountPubkey,
              mint: tokenAccount.account.mint,
            })
          : await provider.claim({
              payerPubKey: feeWalletPubkey,
              referralAccountPubKey: referralAccountPubkey,
              mint: tokenAccount.account.mint,
            });

        logger.info("Claim transaction built", { mint: mintStr, symbol, amount, isToken2022 });

        // The SDK returns a VersionedTransaction directly
        const signature = await signAndBroadcastAdmin(claimTx, feeWalletAddress);

        claimedFees.push({
          mint: mintStr,
          symbol,
          amount,
          signature,
        });

        logger.info("Successfully claimed referral fees", {
          mint: mintStr,
          symbol,
          amount,
          signature,
          referralAccount: referralAccountAddress,
          feeWallet: feeWalletAddress,
          adminEmail,
          isToken2022,
        });

        // Log admin action to audit log (agentId is null for admin actions)
        await createAuditLog({
          agentId: null,
          action: "admin_referral_claim",
          asset: symbol,
          amount,
          to: feeWalletAddress,
          signature,
          status: "confirmed",
          metadata: {
            mint: mintStr,
            referralAccount: referralAccountAddress,
            adminEmail,
            isToken2022,
          },
        });

      } catch (claimErr) {
        logger.error("Failed to claim for token", { mint: mintStr, symbol, error: String(claimErr) });
        // Continue to try other tokens
      }
    }

    if (claimedFees.length === 0) {
      return error(
        c,
        "Failed to claim any referral fees. The fee wallet may not have authority over the referral account. " +
        "Ensure KNOT_FEE_WALLET_ADDRESS is set as the referral account authority on Jupiter's dashboard.",
        500
      );
    }

    return success(c, `Successfully claimed ${claimedFees.length} referral fee token(s).`, {
      claimed: claimedFees,
      totalClaimed: claimedFees.length,
      feeWallet: feeWalletAddress,
    });

  } catch (err) {
    logger.error("Failed to claim referral fees", { error: String(err) });
    return error(c, `Failed to claim referral fees: ${String(err)}`, 500);
  }
});

export { referralRoutes };
