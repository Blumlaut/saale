/**
 * Password bounds for email+password accounts. client-safe.
 *
 * better-auth refuses anything outside the bounds (`src/auth.ts`), so forms check
 * the same numbers to answer before the request goes out.
 */

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/** One line of rules, for helper text and placeholders. */
export const PASSWORD_RULES = `At least ${PASSWORD_MIN_LENGTH} characters`;

/** What is wrong with a password, or null when it is usable. */
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return PASSWORD_RULES;
  if (password.length > PASSWORD_MAX_LENGTH) return `At most ${PASSWORD_MAX_LENGTH} characters`;
  return null;
}
