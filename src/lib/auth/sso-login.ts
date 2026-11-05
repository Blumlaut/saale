/**
 * The browser-safe half of single sign-on: which provider to ask for and what
 * to say when it fails.
 *
 * Kept free of server imports. The login page is a client component, and the
 * refusal an account is turned away with is decided on the server but shown
 * here, so the sentence lives in one place.
 */

import { oauthLoginError } from "./oauth-login-error";

/** The better-auth provider id. The callback lands on `/api/auth/callback/<id>`. */
export const SSO_OIDC_PROVIDER_ID = "sso-oidc";

/** What a sign-in is refused with when the address is not on the allowed domains. */
export const SSO_SIGNUP_REFUSED = {
  code: "SSO_SIGNUP_REFUSED",
  message: "Your address is not on this instance's single sign-on list. Ask an admin to add it.",
} as const;

/**
 * The sentence to show for a login redirect's error, or null when it carries
 * none.
 *
 * `signup_disabled` is the provider arriving with an identity nobody has an
 * account for, which this instance answers with the refusal above.
 */
export function ssoLoginError(
  code: string | null | undefined,
  options: { provider: string },
): string | null {
  return oauthLoginError(code, {
    provider: options.provider,
    messages: {
      signup_disabled: SSO_SIGNUP_REFUSED.message,
      [SSO_SIGNUP_REFUSED.code.toLowerCase()]: SSO_SIGNUP_REFUSED.message,
    },
  });
}
