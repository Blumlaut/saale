/**
 * The browser-safe half of Telegram sign-in: which provider to ask for and what
 * to say when it fails.
 *
 * Kept free of server imports — the sign-in button and the OAuth callback both
 * need the provider id, and the button lives in the client bundle.
 */

/** The better-auth provider id. The callback lands on `/api/auth/callback/<id>`. */
export const TELEGRAM_OIDC_PROVIDER_ID = "telegram-oidc";

/**
 * Readable copy for the error codes better-auth puts in the login redirect.
 *
 * A Telegram login ends up back on the login page with `?error=<code>` — a
 * machine-readable token, not a sentence. Unknown codes are shown as they are:
 * a new better-auth error is better seen than smoothed over.
 */
const LOGIN_ERROR_MESSAGES: Record<string, string> = {
  signups_disabled: "Sign-ups are disabled on this instance. Ask an admin to create your account.",
  account_not_linked:
    "That Telegram account is not linked to a Saale account yet. Sign in with your username first, then link it in Settings → Integrations.",
  account_already_linked_to_different_user:
    "That Telegram account is already linked to a different Saale account.",
  unable_to_link_account: "That Telegram account could not be linked to this account.",
  unable_to_create_user: "Your Saale account could not be created. Try again or ask an admin.",
  unable_to_get_user_info: "Telegram did not return a usable account. Try again.",
  invalid_code: "Telegram rejected the sign-in attempt. Try again.",
  signup_disabled: "Sign-ups are disabled on this instance. Ask an admin to create your account.",
  oauth_provider_not_found:
    "Telegram sign-in is not configured on this instance. Ask an admin to set it up.",
  email_not_found: "Telegram sign-in is not configured on this instance.",
  no_code: "Telegram did not complete the sign-in. Try again.",
  state_not_found: "The sign-in attempt expired. Try again.",
  state_mismatch: "The sign-in attempt could not be verified. Try again.",
  nonce_binding_missing: "The sign-in attempt could not be verified. Try again.",
  issuer_mismatch: "The sign-in attempt could not be verified. Try again.",
  no_callback_url: "The sign-in attempt was missing its return address. Try again.",
  internal_server_error: "Something went wrong signing you in. Try again.",
};

/**
 * The sentence to show for a login redirect's error, or null when it carries
 * none.
 */
export function telegramLoginError(code: string | null | undefined): string | null {
  if (!code) return null;
  return LOGIN_ERROR_MESSAGES[code.trim().toLowerCase()] ?? code;
}
