/**
 * The mail Saale writes to a person on its own account: a verification link and
 * a password reset.
 *
 * Both share one frame (`mail-template.ts`); what differs is the words.
 */

import { getWorkspaceName } from "@/lib/branding/workspace";
import { sendInstanceMail, type InstanceMailResult } from "./instance-mail";
import { renderAccountMail } from "./mail-template";

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
  const { text, html } = renderAccountMail({
    instanceName,
    heading: copy.heading(instanceName),
    url,
    linkLabel: copy.linkLabel,
    note: copy.note,
  });

  return sendInstanceMail({ to, subject: copy.subject(instanceName), text, html });
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
