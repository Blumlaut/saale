/**
 * The instance's two-factor requirement.
 *
 * While an admin requires two-factor, an account that has not set it up may
 * open one page: the one that explains the requirement and enrols it. Every
 * layout that renders the app asks here first.
 */

import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";

/** The page that explains the requirement and enrols the account. */
export const TWO_FACTOR_REQUIRED_PATH = "/auth/two-factor-required";

/** The parts of a session this decision needs. */
export interface TwoFactorGateSession {
  user: { twoFactorEnabled?: boolean | null | undefined };
  session?: { impersonatedBy?: string | null | undefined } | null;
}

/** Whether every account has to set two-factor up before it may use the app. */
export async function isTwoFactorRequired(): Promise<boolean> {
  const row = await prisma.adminSettings.findUnique({
    where: { id: "global" },
    select: { requireTwoFactor: true },
  });

  return row?.requireTwoFactor ?? false;
}

/**
 * Whether this request belongs to an account that still owes the setup.
 *
 * An impersonated session answers to the admin who started it, and the page
 * that clears the requirement stays reachable.
 */
export function owesTwoFactorSetup({
  required,
  session,
  path,
}: {
  required: boolean;
  session: TwoFactorGateSession;
  path: string;
}): boolean {
  if (!required) return false;
  if (session.user.twoFactorEnabled) return false;
  if (session.session?.impersonatedBy) return false;
  return !path.startsWith(TWO_FACTOR_REQUIRED_PATH);
}

/** Sends the caller to the requirement page when the instance requires two-factor. */
export async function enforceTwoFactorSetup(
  session: TwoFactorGateSession,
  path: string,
): Promise<void> {
  const required = await isTwoFactorRequired();
  if (!owesTwoFactorSetup({ required, session, path })) return;
  redirect(TWO_FACTOR_REQUIRED_PATH);
}
