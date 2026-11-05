/**
 * The browser-safe half of Telegram sign-in: which provider to ask for and what
 * to say when it fails.
 *
 * Kept free of server imports. the sign-in button and the OAuth callback both
 * need the provider id, and the button lives in the client bundle.
 */

import { oauthLoginError } from "@/lib/auth/oauth-login-error";

/** The better-auth provider id. The callback lands on `/api/auth/callback/<id>`. */
export const TELEGRAM_OIDC_PROVIDER_ID = "telegram-oidc";

/**
 * The sentence to show for a login redirect's error, or null when it carries
 * none.
 *
 * `signup_disabled` is Telegram arriving with an account nobody linked, so the
 * sentence depends on whether signing up is an option on this instance.
 */
export function telegramLoginError(
  code: string | null | undefined,
  options: { signupsEnabled?: boolean } = {},
): string | null {
  if (!code) return null;

  if (code.trim().toLowerCase() === "signup_disabled") {
    return options.signupsEnabled === false
      ? "That Telegram account is not linked to a Saale account, and sign-ups are not open. Ask an admin to create your account."
      : "That Telegram account is not linked to a Saale account yet. Sign up with Telegram to create one.";
  }

  return oauthLoginError(code, { provider: "Telegram" });
}
