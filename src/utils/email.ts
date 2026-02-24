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
