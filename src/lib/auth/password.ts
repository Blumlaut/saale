/**
 * Password bounds and the account policy they belong to. client-safe.
 *
 * The minimum is a floor: an instance may raise it (admin settings), never
 * lower it. better-auth refuses anything outside these bounds (`src/auth.ts`),
 * and so do the forms, so a short password is answered before the request goes
 * out.
 */

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/** What this instance asks of an account. */
export interface AccountPolicy {
  minPasswordLength: number;
  maxPasswordLength: number;
  requireTwoFactor: boolean;
}

/** The policy of an instance nobody has configured. */
export const DEFAULT_ACCOUNT_POLICY: AccountPolicy = {
  minPasswordLength: PASSWORD_MIN_LENGTH,
  maxPasswordLength: PASSWORD_MAX_LENGTH,
  requireTwoFactor: false,
};

/** Holds a configured minimum inside the range the forms and better-auth honour. */
export function clampMinPasswordLength(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return PASSWORD_MIN_LENGTH;
  return Math.min(Math.max(Math.round(value), PASSWORD_MIN_LENGTH), PASSWORD_MAX_LENGTH);
}

/** One line of rules, for helper text and placeholders. */
export function passwordRules(minLength: number = PASSWORD_MIN_LENGTH): string {
  return `At least ${minLength} characters`;
}

/** What is wrong with a password, or null when it is usable. */
export function passwordProblem(
  password: string,
  minLength: number = PASSWORD_MIN_LENGTH,
): string | null {
  if (password.length < minLength) return passwordRules(minLength);
  if (password.length > PASSWORD_MAX_LENGTH) return `At most ${PASSWORD_MAX_LENGTH} characters`;
  return null;
}

/** Why the policy refused a password, as a sentence, or null when it accepts it. */
export function accountPolicyProblem(password: string, policy: AccountPolicy): string | null {
  const problem = passwordProblem(password, policy.minPasswordLength);
  return problem ? `The password needs ${problem.toLowerCase()}.` : null;
}
