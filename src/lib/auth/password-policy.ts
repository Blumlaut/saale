/**
 * Reads the instance's account policy, and names the endpoints that set a
 * password.
 *
 * better-auth holds its own minimum at the built-in floor at sign-in and at
 * every endpoint that sets a password. An instance that raised the minimum is
 * checked here, before the request reaches the endpoint, so the refusal names
 * the number the admin chose.
 */

import { prisma } from "@/lib/db";
import {
  clampMinPasswordLength,
  DEFAULT_ACCOUNT_POLICY,
  PASSWORD_MAX_LENGTH,
  type AccountPolicy,
} from "@/lib/auth/password";

/** What this instance accepts right now. */
export async function getAccountPolicy(): Promise<AccountPolicy> {
  const row = await prisma.adminSettings.findUnique({
    where: { id: "global" },
    select: { minPasswordLength: true, requireTwoFactor: true },
  });

  return {
    minPasswordLength: clampMinPasswordLength(
      row?.minPasswordLength ?? DEFAULT_ACCOUNT_POLICY.minPasswordLength,
    ),
    maxPasswordLength: PASSWORD_MAX_LENGTH,
    requireTwoFactor: row?.requireTwoFactor ?? DEFAULT_ACCOUNT_POLICY.requireTwoFactor,
  };
}

/** Where each endpoint that sets a password carries the new one. */
export const PASSWORD_FIELD_BY_PATH: Readonly<Record<string, string>> = {
  "/sign-up/email": "password",
  "/admin/create-user": "password",
  "/admin/set-user-password": "newPassword",
  "/change-password": "newPassword",
  "/set-password": "newPassword",
  "/reset-password": "newPassword",
};
