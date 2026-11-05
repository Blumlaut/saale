import { APIError } from "better-auth/api";
import { prisma } from "@/lib/db";
import { SSO_CALLBACK_PATH, isSsoEmailAllowed } from "@/lib/auth/sso";
import { SSO_SIGNUP_REFUSED } from "@/lib/auth/sso-login";

/**
 * Who may create an account.
 *
 * The register form asks, but a form is not a gate. the server decides, and it
 * has to decide the same way for every path that creates a user, including the
 * ones that never render a form (a Telegram login creates an account in a
 * redirect). This is that decision, in one place.
 */

/** The admin plugin's user-creation endpoint. */
export const ADMIN_CREATE_USER_PATH = "/admin/create-user";

/** Refusal shown when an account cannot be created because sign-ups are off. */
export const SIGNUPS_DISABLED_ERROR = {
  code: "SIGNUPS_DISABLED",
  message: "Sign-ups are disabled on this instance. Ask an admin to create your account.",
} as const;

/** The admin's sign-up setting, defaulting to on for an unconfigured instance. */
export async function areSignupsEnabled(): Promise<boolean> {
  const settings = await prisma.adminSettings.findUnique({
    where: { id: "global" },
    select: { signupsEnabled: true },
  });

  return settings?.signupsEnabled ?? true;
}

/**
 * Refuse the creation when it would be a sign-up and sign-ups are off.
 *
 * Three creations are not sign-ups: the bootstrap account (nothing else can get
 * an instance going), an account an admin creates for someone else, and a
 * single sign-on login from an allowed domain, where the company's own
 * directory is the list of people who may have an account.
 *
 * @param context - The endpoint context of the creation, when there is one.
 * @param email - The address the account would be created for.
 */
export async function assertSignupsAllowed(
  context: { path?: string } | null | undefined,
  email?: string | null,
): Promise<void> {
  if (context?.path === ADMIN_CREATE_USER_PATH) return;
  if ((await prisma.user.count()) === 0) return;

  if (context?.path === SSO_CALLBACK_PATH) {
    if (email && isSsoEmailAllowed(email)) return;
    throw APIError.from("FORBIDDEN", SSO_SIGNUP_REFUSED);
  }

  if (await areSignupsEnabled()) return;

  throw APIError.from("FORBIDDEN", SIGNUPS_DISABLED_ERROR);
}
