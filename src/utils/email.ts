import { config } from "../config.js";
import { logger } from "./logger.js";

// Hardcoded sender address (not sensitive, non-secret config)
const SENDER_NAME = "Knot";
const SENDER_EMAIL = "noreply@notification.useknot.xyz";

const MAILTRAP_API_URL = "https://send.api.mailtrap.io/api/send";

logger.info("Mail service configured", {
  provider: "mailtrap-api",
  fromEmail: SENDER_EMAIL,
});

/**
 * Send OTP code via email using Mailtrap API
 */
export async function sendOtpEmail(email: string, otpCode: string): Promise<void> {
  const htmlContent = `
    <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #333; margin-bottom: 20px;">Knot Wallet</h2>
      <p style="color: #666; margin-bottom: 20px;">Your verification code is:</p>
      <div style="background: #f5f5f5; padding: 20px; text-align: center; border-radius: 8px; margin-bottom: 20px;">
        <span style="font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #333;">${otpCode}</span>
      </div>
      <p style="color: #999; font-size: 14px;">This code expires in 10 minutes.</p>
      <p style="color: #999; font-size: 14px;">If you didn't request this code, you can safely ignore this email.</p>
    </div>
  `;

  const textContent = `Your verification code is: ${otpCode}\n\nThis code expires in 10 minutes.\n\nIf you didn't request this code, you can safely ignore this email.`;

  try {
    logger.info("Attempting to send OTP email", {
      email,
      provider: "mailtrap-api",
    });

    const response = await fetch(MAILTRAP_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.MAILTRAP_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: {
          email: SENDER_EMAIL,
          name: SENDER_NAME,
        },
        to: [
          {
            email,
          },
        ],
        subject: "Your Knot Wallet verification code",
        text: textContent,
        html: htmlContent,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Mailtrap API error: ${response.status} ${response.statusText}. ${errorBody}`
      );
    }

    const responseData = (await response.json()) as { success?: boolean; message_id?: string };

    logger.info("OTP email sent successfully", {
      email,
      provider: "mailtrap-api",
      messageId: responseData.message_id,
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Failed to send OTP email", {
      email,
      error: errorMessage,
      provider: "mailtrap-api",
    });
    throw new Error(`Failed to send verification email: ${errorMessage}`);
  }
}

/**
 * Send deposit notification email using Mailtrap API
 */
export async function sendDepositNotification(
  email: string,
  amount: number,
  asset: string,
  usdValue: number | null,
  signature: string,
  fromAddress?: string
): Promise<void> {
  // Format asset name nicely
  const assetName = asset === "sol" ? "SOL" : asset.toUpperCase();
  const explorerUrl = `https://solscan.io/tx/${signature}`;

  // Format USD value if available
  const usdDisplay = usdValue ? ` (~$${usdValue.toFixed(2)} USD)` : "";

  const htmlContent = `
    <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #333; margin-bottom: 10px;">💰 You Got Money!</h2>
      <p style="color: #666; font-size: 16px; margin-bottom: 30px;">Your Knot wallet just received a deposit.</p>

      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 25px; border-radius: 12px; margin-bottom: 25px; text-align: center;">
        <p style="color: rgba(255,255,255,0.9); margin: 0 0 8px 0; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">Received</p>
        <p style="color: white; margin: 0; font-size: 32px; font-weight: bold;">
          ${amount.toLocaleString()} ${assetName}
        </p>
        ${usdDisplay ? `<p style="color: rgba(255,255,255,0.8); margin: 8px 0 0 0; font-size: 16px;">${usdDisplay}</p>` : ""}
      </div>

      ${fromAddress ? `
      <div style="background: #f5f5f5; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
        <p style="color: #666; margin: 0 0 5px 0; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">From</p>
        <p style="color: #333; margin: 0; font-size: 14px; font-family: monospace; word-break: break-all;">${fromAddress}</p>
      </div>
      ` : ""}

      <div style="text-align: center; margin-bottom: 20px;">
        <a href="${explorerUrl}" style="display: inline-block; background: #333; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 500;">
          View Transaction
        </a>
      </div>

      <p style="color: #999; font-size: 12px; text-align: center; margin: 0;">
        This is an automated notification from your Knot wallet.
      </p>
    </div>
  `;

  const textContent = `You Got Money! 💰

Your Knot wallet just received a deposit.

Amount: ${amount.toLocaleString()} ${assetName}${usdDisplay}
${fromAddress ? `From: ${fromAddress}` : ""}

View transaction: ${explorerUrl}

This is an automated notification from your Knot wallet.`;

  try {
    logger.info("Attempting to send deposit notification email", {
      email,
      amount,
      asset: assetName,
      usdValue,
      provider: "mailtrap-api",
    });

    const response = await fetch(MAILTRAP_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.MAILTRAP_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: {
          email: SENDER_EMAIL,
          name: SENDER_NAME,
        },
        to: [
          {
            email,
          },
        ],
        subject: `💰 You received ${amount.toLocaleString()} ${assetName}`,
        text: textContent,
        html: htmlContent,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Mailtrap API error: ${response.status} ${response.statusText}. ${errorBody}`
      );
    }

    const responseData = (await response.json()) as { success?: boolean; message_id?: string };

    logger.info("Deposit notification email sent successfully", {
      email,
      amount,
      asset: assetName,
      provider: "mailtrap-api",
      messageId: responseData.message_id,
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Failed to send deposit notification email", {
      email,
      amount,
      asset: assetName,
      error: errorMessage,
      provider: "mailtrap-api",
    });
    // Don't throw - we don't want email failures to block webhook processing
    logger.warn("Deposit notification email failed, but deposit was still logged", {
      email,
      signature,
    });
  }
}
