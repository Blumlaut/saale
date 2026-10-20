/**
 * Username rules. the handle used to sign in.
 *
 * A username is stored lowercased, so `Ada.Lovelace` and `ada.lovelace` are the
 * same account. Allowed characters: letters, numbers, dots, dashes, underscores.
 */

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 30;
export const USERNAME_PATTERN = /^[a-z0-9._-]+$/;

/** Shared wording for the sign-up form hint and the invalid-username error. */
export const USERNAME_RULES = "3-30 characters: letters, numbers, dots, dashes or underscores";

/** Rejected sign-ups: a credential account without a handle cannot be used. */
export const USERNAME_REQUIRED_ERROR = {
  code: "USERNAME_REQUIRED",
  message: `A username is required. ${USERNAME_RULES}`,
} as const;

/** The stored form of a username: trimmed, lowercased. Idempotent. */
export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Validates a username, in raw or already-normalized form.
 *
 * Used both by the better-auth username plugin (`usernameValidator`) and by the
 * forms, so the client and the server reject exactly the same values.
 */
export function isValidUsername(value: string): boolean {
  const username = normalizeUsername(value);
  return (
    username.length >= USERNAME_MIN_LENGTH &&
    username.length <= USERNAME_MAX_LENGTH &&
    USERNAME_PATTERN.test(username)
  );
}
