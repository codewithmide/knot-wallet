import nodemailer from "nodemailer";
import { config } from "../config.js";
import { logger } from "./logger.js";

// Create reusable transporter with timeouts
const transporter = nodemailer.createTransport({
  host: config.SMTP_HOST,
  port: config.SMTP_PORT,
  secure: config.SMTP_PORT === 465, // true for 465, false for other ports
  auth: {
    user: config.SMTP_USERNAME,
    pass: config.SMTP_PASS,
  },
  connectionTimeout: 10000, // 10 seconds to establish connection
  greetingTimeout: 10000,   // 10 seconds for greeting
  socketTimeout: 15000,     // 15 seconds for socket inactivity
});

// Verify SMTP connection on startup
transporter.verify()
  .then(() => logger.info("SMTP connection verified successfully"))
  .catch((err) => logger.warn("SMTP connection failed on startup - emails may not send", { error: String(err) }));

/**
 * Send OTP code via email
 */
export async function sendOtpEmail(email: string, otpCode: string): Promise<void> {
  const mailOptions = {
    from: config.EMAIL_FROM,
    to: email,
    subject: "Your Knot Wallet verification code",
    text: `Your verification code is: ${otpCode}\n\nThis code expires in 10 minutes.\n\nIf you didn't request this code, you can safely ignore this email.`,
    html: `
      <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #333; margin-bottom: 20px;">Knot Wallet</h2>
        <p style="color: #666; margin-bottom: 20px;">Your verification code is:</p>
        <div style="background: #f5f5f5; padding: 20px; text-align: center; border-radius: 8px; margin-bottom: 20px;">
          <span style="font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #333;">${otpCode}</span>
        </div>
        <p style="color: #999; font-size: 14px;">This code expires in 10 minutes.</p>
        <p style="color: #999; font-size: 14px;">If you didn't request this code, you can safely ignore this email.</p>
      </div>
    `,
  };

  try {
    logger.info("Attempting to send OTP email", { email, smtpHost: config.SMTP_HOST, smtpPort: config.SMTP_PORT });
    const result = await transporter.sendMail(mailOptions);
    logger.info("OTP email sent successfully", { email, emailMessageId: result.messageId, note: "This emailMessageId is NOT the otpId" });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorCode = (error as { code?: string })?.code;
    logger.error("Failed to send OTP email", {
      email,
      error: errorMessage,
      errorCode,
      smtpHost: config.SMTP_HOST,
      smtpPort: config.SMTP_PORT
    });
    throw new Error(`Failed to send verification email: ${errorMessage}`);
  }
}
