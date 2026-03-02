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
  _fromAddress?: string
): Promise<void> {
  // Asset should already be a resolved symbol (e.g. "SOL", "USDC", "TRUMP")
  // Only uppercase if it's a short symbol, not a mint address
  const assetName = asset.length <= 10 ? asset.toUpperCase() : asset.slice(0, 6) + "...";

  // Format amount with USD value if available
  const amountDisplay = usdValue
    ? `~$${usdValue.toFixed(2)} USD`
    : `${amount.toLocaleString()} ${assetName}`;

  const htmlContent = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html dir="ltr" lang="en">
  <head>
    <link
      rel="preload"
      as="image"
      href="https://res.cloudinary.com/dqetipg73/image/upload/v1768664846/FossaPay_Logo_3_zna43c.jpg" />
    <meta content="text/html; charset=UTF-8" http-equiv="Content-Type" />
    <meta name="x-apple-disable-message-reformatting" />
    <link href="https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&family=Inter+Tight:ital,wght@0,100..900;1,100..900&display=swap" rel="stylesheet">
    <style>
      :root{--font-inter-tight: "Inter Tight", Inter, Arial, sans-serif;}
      body{font-family:var(--font-inter-tight);}
      a { color:#007ee6; }
      .social-icon { vertical-align:middle; margin-right:8px; }
    </style>
  </head>
  <body style="background-color:rgb(246,249,252)">
    <table border="0" width="100%" cellpadding="0" cellspacing="0" align="center" style="background-color:#f6f9fc;">
      <tr>
        <td align="center">
          <table border="0" width="600" cellpadding="0" cellspacing="0" style="background-color:#fff;border:1px solid #e0e0e0;">
            <tr>
              <td style="padding:40px 40px 20px 40px;">
                <table width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="font-size:18px;font-family:var(--font-inter-tight);color:rgb(64,64,64);padding-bottom:16px;">Hi ${email},</td>
                  </tr>
                  <tr>
                    <td style="font-size:16px;font-family:var(--font-inter-tight);color:rgb(64,64,64);padding-bottom:16px;">
                      We are pleased to inform you that you just received a deposit to your Agent wallet.
                    </td>
                  </tr>
                  <tr>
                    <td style="font-size:16px; padding:10px 0px; font-family:var(--font-inter-tight);color:rgb(64,64,64);padding-bottom:8px;font-weight:bold;">Transaction Details</td>
                  </tr>
                  <tr>
                    <td>
                      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:16px;">
                        <tr><td style="font-size:15px;color:#404040;padding:4px 0;width:150px; padding:10px 0px;">Amount:</td><td style="font-size:15px;color:#404040;padding:4px 0;text-align:right;">${amountDisplay}</td></tr>
                        <tr><td style="font-size:15px;color:#404040;padding:4px 0;width:150px; padding:10px 0px;">Transaction ID:</td><td style="font-size:15px;color:#404040;padding:4px 0;text-align:right;">${signature}</td></tr>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td style="font-size:16px;font-family:var(--font-inter-tight);color:rgb(64,64,64);padding-bottom:16px;">
                      You can review your transaction history and account balance by logging into your account.
                    </td>
                  </tr>
                  <tr>
                    <td style="font-size:16px;font-family:var(--font-inter-tight);color:rgb(64,64,64);padding-bottom:16px;">Best regards,</td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const textContent = `Hi ${email},

We are pleased to inform you that you just received a deposit to your Agent wallet.

Transaction Details:
- Amount: ${amountDisplay}
- Currency: ${assetName}
- Transaction ID: ${signature}

You can review your transaction history and account balance by logging into your account.

Best regards,
Knot`;

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
        subject: "Deposit Notification",
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
