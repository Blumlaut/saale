/**
 * Readable copy for the error codes better-auth puts in a login redirect.
 *
 * A failed OAuth sign-in lands back on the login page with `?error=<code>`, a
 * machine-readable token rather than a sentence. Every provider's codes are the
 * same set, so the sentences live here once and take the provider's name.
 *
 * Client-safe: the login page is a client component.
 */

/** The sentences shared by every OAuth provider, keyed by better-auth's code. */
const OAUTH_ERROR_MESSAGES: Record<string, (provider: string) => string> = {
  signups_disabled: () =>
    "Sign-ups are disabled on this instance. Ask an admin to create your account.",
  account_not_linked: (provider) =>
    `That ${provider} account is not linked to a Saale account yet. Sign in with your username first, then link it in Settings → Integrations.`,
  account_already_linked_to_different_user: (provider) =>
    `That ${provider} account is already linked to a different Saale account.`,
  unable_to_link_account: (provider) =>
    `That ${provider} account could not be linked to this account.`,
  unable_to_create_user: () =>
    "Your Saale account could not be created. Try again or ask an admin.",
  unable_to_get_user_info: (provider) => `${provider} did not return a usable account. Try again.`,
  invalid_code: (provider) => `${provider} rejected the sign-in attempt. Try again.`,
  oauth_provider_not_found: (provider) =>
    `${provider} sign-in is not configured on this instance. Ask an admin to set it up.`,
  email_not_found: (provider) => `${provider} sign-in is not configured on this instance.`,
  no_code: (provider) => `${provider} did not complete the sign-in. Try again.`,
  state_not_found: () => "The sign-in attempt expired. Try again.",
  state_mismatch: () => "The sign-in attempt could not be verified. Try again.",
  nonce_binding_missing: () => "The sign-in attempt could not be verified. Try again.",
  issuer_mismatch: () => "The sign-in attempt could not be verified. Try again.",
  no_callback_url: () => "The sign-in attempt was missing its return address. Try again.",
  internal_server_error: () => "Something went wrong signing you in. Try again.",
};

/**
 * The sentence to show for a login redirect's error, or null when it carries
 * none.
 *
 * `messages` is where a provider adds the codes it reads differently, and
 * overrides a shared sentence when its own wording fits better. An unknown code
 * is shown as it is: a new better-auth error is better seen than smoothed over.
 */
export function oauthLoginError(
  code: string | null | undefined,
  options: { provider: string; messages?: Record<string, string> },
): string | null {
  if (!code) return null;

  const key = code.trim().toLowerCase();
  const own = options.messages?.[key];
  if (own) return own;

  const shared = OAUTH_ERROR_MESSAGES[key];
  return shared ? shared(options.provider) : code;
}
