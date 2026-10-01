/**
 * Session invalidation when two-factor authentication is enabled.
 *
 * better-auth only enforces the 2FA challenge at sign-in. Sessions that were
 * created *before* 2FA is enabled never verified a second factor, so they
 * must not survive the enablement. The two-factor plugin re-issues a session
 * for the browser completing setup right after the user update, so that
 * browser stays signed in while every other device is signed out.
 */

/** Minimal shape of the `databaseHooks.user.update.after` endpoint context. */
export interface UserUpdateHookContext {
  path: string;
  context: {
    internalAdapter: {
      deleteUserSessions(userId: string): Promise<void>;
    };
  };
}

/** better-auth endpoints whose user update enables 2FA. */
const TWO_FACTOR_ENABLE_PATHS = new Set(["/two-factor/enable", "/two-factor/verify-totp"]);

/**
 * Revokes all of a user's sessions when 2FA is enabled.
 *
 * Wire in as `databaseHooks.user.update.after` in the better-auth config.
 * The two-factor plugin sets `twoFactorEnabled` via `updateUser` *before*
 * creating the replacement session, so at hook time only pre-2FA sessions
 * exist and deleting all of them is safe.
 */
export async function revokeSessionsOnTwoFactorEnable(
  user: { id: string; twoFactorEnabled?: boolean | null },
  context: UserUpdateHookContext | null,
): Promise<void> {
  if (!user.twoFactorEnabled) return;
  if (!context || !TWO_FACTOR_ENABLE_PATHS.has(context.path)) return;
  await context.context.internalAdapter.deleteUserSessions(user.id);
}
