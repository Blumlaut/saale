/**
 * The instance's own mail: one SMTP relay, configured in the admin panel.
 *
 * Verification links and password resets leave through it. A deployment with
 * nothing configured sends nothing, and every caller copes with that instead of
 * failing: an instance has to be usable before it has a mail server, which is
 * how the first account gets created.
 */

import nodemailer from "nodemailer";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getWorkspaceName } from "@/lib/branding/workspace";
import { decrypt, encrypt } from "@/lib/crypto";
import { sanitizeHeader } from "./header";
import { renderAccountMail } from "./mail-template";
import {
  MAIL_SECURITIES,
  type InstanceMailSettings,
  type InstanceMailStatus,
  type MailSecurity,
} from "./mail-config";

const DEFAULT_SMTP_PORT = 587;
const SEND_TIMEOUT_MS = 15_000;

/** What a send needs: the settings plus the secret behind them. */
export interface InstanceMailTransport extends InstanceMailSettings {
  password: string | null;
}

const settingsSchema = z.object({
  enabled: z.boolean(),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65_535),
  security: z.enum(MAIL_SECURITIES),
  username: z.string().trim().max(320),
  fromAddress: z.email().max(320),
  fromName: z.string().trim().max(120),
});

export const instanceMailPatchSchema = settingsSchema.partial().extend({
  /** A new password. `null` forgets the stored one, absent leaves it alone. */
  password: z.string().max(1024).nullable().optional(),
});

export type InstanceMailPatch = z.infer<typeof instanceMailPatchSchema>;

function settingsOf(row: {
  enabled: boolean;
  host: string;
  port: number;
  security: string;
  username: string;
  fromAddress: string;
  fromName: string;
}): InstanceMailSettings {
  return {
    enabled: row.enabled,
    host: row.host,
    port: row.port,
    security: isMailSecurity(row.security) ? row.security : "starttls",
    username: row.username,
    fromAddress: row.fromAddress,
    fromName: row.fromName,
  };
}

function isMailSecurity(value: string): value is MailSecurity {
  return (MAIL_SECURITIES as readonly string[]).includes(value);
}

/** A relay that can carry mail: switched on, addressed, and given a sender. */
function isUsable(settings: InstanceMailSettings): boolean {
  return settings.enabled && settings.host.length > 0 && settings.fromAddress.length > 0;
}

async function readRow() {
  return prisma.instanceMail.findUnique({ where: { id: "global" } });
}

/** The configuration the admin panel shows, or the empty one. */
export async function instanceMailStatus(): Promise<InstanceMailStatus> {
  const row = await readRow();
  if (!row) {
    return {
      configured: false,
      // The switch starts on: filling in a relay is the intent to use it.
      enabled: true,
      host: "",
      port: DEFAULT_SMTP_PORT,
      security: "starttls",
      username: "",
      fromAddress: "",
      fromName: "",
      hasPassword: false,
      updatedAt: null,
      updatedByUserId: null,
    };
  }

  const settings = settingsOf(row);
  return {
    ...settings,
    configured: isUsable(settings),
    hasPassword: Boolean(row.encryptedPassword),
    updatedAt: row.updatedAt.toISOString(),
    updatedByUserId: row.updatedByUserId,
  };
}

/**
 * The relay and its password, or null when the instance cannot send.
 *
 * A password that will not decrypt is logged and dropped: the rest of the
 * settings stay usable for a relay that needs no authentication, and a wrong
 * `ENCRYPTION_KEY` shows up as a send failure rather than a crash.
 */
export async function getInstanceMailTransport(): Promise<InstanceMailTransport | null> {
  const row = await readRow();
  if (!row) return null;

  const settings = settingsOf(row);
  if (!isUsable(settings)) return null;

  let password: string | null = null;
  if (row.encryptedPassword) {
    try {
      password = decrypt(row.encryptedPassword);
    } catch (err) {
      console.error("Failed to decrypt the instance mail password:", err);
    }
  }

  return { ...settings, password };
}

function transportFor(config: InstanceMailTransport) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.security === "tls",
    requireTLS: config.security === "starttls",
    auth: config.username ? { user: config.username, pass: config.password ?? "" } : undefined,
    connectionTimeout: SEND_TIMEOUT_MS,
    greetingTimeout: SEND_TIMEOUT_MS,
    socketTimeout: SEND_TIMEOUT_MS,
  });
}

export interface InstanceMailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Display name beside the sender's address, when the instance has one. */
  fromName?: string;
}

export interface InstanceMailResult {
  sent: boolean;
  /** Why it did not go, when it did not. */
  error?: string;
}

/**
 * Send one message through the instance's relay.
 *
 * A deployment with no relay reports `sent: false` and logs it, because the
 * caller is usually a sign-up or a password reset that has to finish anyway.
 */
export async function sendInstanceMail(message: InstanceMailMessage): Promise<InstanceMailResult> {
  const config = await getInstanceMailTransport();
  if (!config) {
    console.warn(`Instance mail is not configured; "${message.subject}" was not sent`);
    return { sent: false, error: "Instance mail is not configured" };
  }

  const fromName = sanitizeHeader(message.fromName ?? config.fromName);
  const from = fromName
    ? `${fromName} <${sanitizeHeader(config.fromAddress)}>`
    : sanitizeHeader(config.fromAddress);

  try {
    await transportFor(config).sendMail({
      from,
      to: sanitizeHeader(message.to),
      subject: sanitizeHeader(message.subject),
      text: message.text,
      html: message.html,
    });
    return { sent: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown SMTP failure";
    console.error(`Failed to send "${message.subject}" through the instance mail relay:`, err);
    return { sent: false, error };
  }
}

/** Save a patch over the stored configuration. */
export async function saveInstanceMail(
  patch: InstanceMailPatch,
  updatedByUserId: string,
): Promise<InstanceMailStatus> {
  const row = await readRow();
  const current = row
    ? settingsOf(row)
    : {
        enabled: true,
        host: "",
        port: DEFAULT_SMTP_PORT,
        security: "starttls" as MailSecurity,
        username: "",
        fromAddress: "",
        fromName: "",
      };

  const { password, ...settingsPatch } = patch;
  const settings = settingsSchema.parse({ ...current, ...settingsPatch });

  const secret =
    password === undefined
      ? (row?.encryptedPassword ?? null)
      : password === null
        ? null
        : encrypt(password);

  await prisma.instanceMail.upsert({
    where: { id: "global" },
    create: { id: "global", ...settings, encryptedPassword: secret, updatedByUserId },
    update: { ...settings, encryptedPassword: secret, updatedByUserId },
  });

  return instanceMailStatus();
}

/** Forget the relay, password and all. */
export async function clearInstanceMail(): Promise<void> {
  await prisma.instanceMail.deleteMany({ where: { id: "global" } });
}

/**
 * Send a test message so an admin can prove the relay works.
 *
 * This is the one caller that reports the failure to a person, so the reason
 * comes back rather than only reaching the log.
 */
export async function sendInstanceMailTest(to: string): Promise<InstanceMailResult> {
  const instanceName = await getWorkspaceName();
  const { text, html } = renderAccountMail({
    instanceName,
    heading: "This is a test message from your instance.",
    note: "Verification links and password resets go out through this relay.",
  });

  return sendInstanceMail({ to, subject: `${instanceName} can send mail`, text, html });
}
