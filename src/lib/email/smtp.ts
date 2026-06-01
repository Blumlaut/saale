import nodemailer from "nodemailer";

/**
 * Send an email via SMTP.
 */
export async function sendEmail(params: {
  account: {
    email: string;
    smtpHost: string;
    smtpPort: number;
    smtpSecure: boolean;
  };
  password: string;
  to: string[];
  subject: string;
  body: string;
  bodyHtml?: string;
  replyTo?: string;
  cc?: string[];
  bcc?: string[];
}): Promise<{ messageId: string }> {
  const transporter = nodemailer.createTransport({
    host: params.account.smtpHost,
    port: params.account.smtpPort,
    secure: params.account.smtpSecure,
    auth: {
      user: params.account.email,
      pass: params.password,
    },
  });

  const info = await transporter.sendMail({
    from: params.account.email,
    to: params.to.join(", "),
    cc: params.cc?.join(", "),
    bcc: params.bcc?.join(", "),
    replyTo: params.replyTo,
    subject: params.subject,
    text: params.body,
    html: params.bodyHtml ?? undefined,
  });

  return { messageId: info.messageId };
}

/**
 * Test an SMTP connection.
 */
export async function testSmtpConnection(params: {
  host: string;
  port: number;
  secure: boolean;
  email: string;
  password: string;
}): Promise<{ success: boolean; error?: string }> {
  const transporter = nodemailer.createTransport({
    host: params.host,
    port: params.port,
    secure: params.secure,
    auth: {
      user: params.email,
      pass: params.password,
    },
  });

  try {
    await transporter.verify();
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: (err as Error).message,
    };
  }
}
