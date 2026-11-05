/**
 * The mail Saale writes to a person on its own account: a verification link and
 * a password reset.
 *
 * Both are plain text with a matching HTML part. The link is the whole message,
 * so it stays a single line in a mail client that strips the formatting.
 */

import { getWorkspaceName } from "@/lib/branding/workspace";
import { sendInstanceMail, type InstanceMailResult } from "./instance-mail";

/** The words that differ between the two mails. */
interface AccountMailCopy {
  subject: (instanceName: string) => string;
  heading: (instanceName: string) => string;
  linkLabel: string;
  note: string;
}

async function sendAccountMail(
  to: string,
  url: string,
  copy: AccountMailCopy,
): Promise<InstanceMailResult> {
  const instanceName = await getWorkspaceName();
  const heading = copy.heading(instanceName);

  return sendInstanceMail({
    to,
    subject: copy.subject(instanceName),
    text: [heading, "", url, "", copy.note].join("\n"),
    html: [
      `<p style="margin:0 0 16px;font-size:15px;line-height:1.5">${heading}</p>`,
      `<p style="margin:0 0 16px"><a href="${url}" style="font-size:15px">${copy.linkLabel}</a></p>`,
      `<p style="margin:0 0 16px;font-size:15px;line-height:1.5">${copy.note}</p>`,
      `<p style="margin:24px 0 0;font-size:13px;color:#666">${instanceName}</p>`,
    ].join(""),
  });
}

/** A verification link, sent on sign-up and on request. */
export async function sendVerificationMail(to: string, url: string): Promise<InstanceMailResult> {
  return sendAccountMail(to, url, {
    subject: (name) => `Confirm your address for ${name}`,
    heading: (name) => `Confirm this address to finish setting up your ${name} account.`,
    linkLabel: "Confirm the address",
    note: "The link is good for one hour.",
  });
}

/** A password reset link, sent when someone asks for one. */
export async function sendPasswordResetMail(to: string, url: string): Promise<InstanceMailResult> {
  return sendAccountMail(to, url, {
    subject: (name) => `Reset your ${name} password`,
    heading: (name) => `Someone asked to reset the password for this ${name} account.`,
    linkLabel: "Choose a new password",
    note: "The link is good for one hour. If this was not you, ignore this message.",
  });
}
