import nodemailer from "nodemailer";
import { config } from "../config.js";
import { logger } from "./logger.js";

// Create reusable transporter with timeouts
const transporter = nodemailer.createTransport({
  host: config.SMTP_HOST,
  port: config.SMTP_PORT,
  secure: config.SMTP_PORT === 465,
  auth: {
    user: config.SMTP_USERNAME,
    pass: config.SMTP_PASS,
  },
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 15000,
});

interface MailtrapRecipient {
  email: string;
}

interface ParsedFrom {
  name: string;
  email: string;
}

function parseFromAddress(input: string): ParsedFrom {
  const normalized = input.trim().replace(/^['"]|['"]$/g, "");

  const match = normalized.match(/^\s*([^<]+?)\s*<\s*([^>]+)\s*>\s*$/);
  if (match) {
    return { name: match[1].trim(), email: match[2].trim() };
  }

  if (normalized.includes("@")) {
    return { name: "Knot", email: normalized.trim() };
  }

  throw new Error("EMAIL_FROM must be a valid email or in 'Name <email>' format");
}

const fromAddress = parseFromAddress(config.EMAIL_FROM);
logger.info("Mail service configured", {
  provider: "smtp",
  fromEmail: fromAddress.email,
  smtpHost: config.SMTP_HOST,
  smtpPort: config.SMTP_PORT,
});

transporter
  .verify()
  .then(() => logger.info("SMTP connection verified successfully"))
  .catch((err) =>
    logger.warn("SMTP connection failed on startup - emails may not send", {
      error: String(err),
    })
  );

/**
 * Send OTP code via email
 */
export async function sendOtpEmail(email: string, otpCode: string): Promise<void> {
  const mailOptions = {
    from: {
      email: fromAddress.email,
      name: fromAddress.name,
    },
    to: [{ email }] as MailtrapRecipient[],
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
    logger.info("Attempting to send OTP email", {
      email,
      provider: "smtp",
      smtpHost: config.SMTP_HOST,
      smtpPort: config.SMTP_PORT,
    });

    const response = await transporter.sendMail({
      from: `${mailOptions.from.name} <${mailOptions.from.email}>`,
      to: mailOptions.to.map((recipient) => recipient.email).join(", "),
      subject: mailOptions.subject,
      text: mailOptions.text,
      html: mailOptions.html,
    });

    logger.info("OTP email sent successfully", {
      email,
      provider: "smtp",
      emailMessageId: response.messageId,
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Failed to send OTP email", {
      email,
      error: errorMessage,
      provider: "smtp",
      smtpHost: config.SMTP_HOST,
      smtpPort: config.SMTP_PORT,
    });
    throw new Error(`Failed to send verification email: ${errorMessage}`);
  }
}
