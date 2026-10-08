import fs from "fs/promises";
import path from "path";
import nodemailer, { type SendMailOptions } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";

/** Strip CR/LF characters to prevent email header injection. */
function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]/g, "");
}

/** MIME types by file extension */
const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
};

/** Guess MIME type from file extension */
function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

/** Max total attachment size (20 MB to leave headroom for provider limits) */
const MAX_TOTAL_ATTACHMENT_SIZE = 20 * 1024 * 1024;

/**
 * Resolve attachment paths and read file contents.
 * Returns an array of nodemailer-compatible attachment objects.
 */
async function resolveAttachments(
  baseDir: string,
  filePaths: string[],
): Promise<Array<{ filename: string; content: Buffer; contentType: string }>> {
  const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];
  let totalSize = 0;

  for (const filePath of filePaths) {
    const resolved = path.resolve(baseDir, filePath);
    const normalizedBase = path.resolve(baseDir);

    // Escape detection
    if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
      throw new Error(`Access denied: path "${filePath}" escapes workspace`);
    }

    let stats;
    try {
      stats = await fs.stat(resolved);
    } catch {
      throw new Error(`Attachment not found: ${filePath}`);
    }

    if (!stats.isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }

    totalSize += stats.size;
    if (totalSize > MAX_TOTAL_ATTACHMENT_SIZE) {
      throw new Error(
        `Total attachment size (${(totalSize / 1024 / 1024).toFixed(1)}MB) exceeds limit (${(MAX_TOTAL_ATTACHMENT_SIZE / 1024 / 1024).toFixed(0)}MB)`,
      );
    }

    const content = await fs.readFile(resolved);
    attachments.push({
      filename: path.basename(filePath),
      content,
      contentType: guessMimeType(filePath),
    });
  }

  return attachments;
}

/**
 * Send an email via SMTP.
 *
 * Returns the raw MIME source of the message alongside its id so the caller can
 * file an identical copy in the account's Sent folder: submitting over SMTP
 * leaves no trace there on most servers, and the copy has to carry the same
 * Message-ID as the delivered message for the two to be recognised as one.
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
  /** File paths relative to a base directory (e.g. user workspace). */
  attachmentPaths?: string[];
  /** Base directory to resolve attachment paths against. */
  attachmentBaseDir?: string;
}): Promise<{ messageId: string; raw: Buffer; date: Date }> {
  const transporter = nodemailer.createTransport({
    host: params.account.smtpHost,
    port: params.account.smtpPort,
    secure: params.account.smtpSecure,
    auth: {
      user: params.account.email,
      pass: params.password,
    },
  });

  const mailOptions: SendMailOptions = {
    from: params.account.email,
    to: params.to.map(sanitizeHeader).join(", "),
    cc: params.cc?.map(sanitizeHeader).join(", "),
    bcc: params.bcc?.map(sanitizeHeader).join(", "),
    replyTo: params.replyTo ? sanitizeHeader(params.replyTo) : undefined,
    subject: sanitizeHeader(params.subject),
    text: params.body,
    html: params.bodyHtml ?? undefined,
  };

  // Resolve and attach files if provided
  if (params.attachmentPaths?.length && params.attachmentBaseDir) {
    mailOptions.attachments = await resolveAttachments(
      params.attachmentBaseDir,
      params.attachmentPaths,
    );
  }

  // Compose the message to pin its Message-ID and Date: the transporter renders
  // its own copy for delivery, and both have to agree so the delivered message
  // and the Sent copy are one mail. The pinned id is what the caller reports.
  const date = new Date();
  const node = new MailComposer({ ...mailOptions, date }).compile();
  const messageId = node.messageId();
  const raw = await node.build();

  await transporter.sendMail({ ...mailOptions, messageId, date });

  return { messageId, raw, date };
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
