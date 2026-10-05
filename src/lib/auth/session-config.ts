import type { BetterAuthOptions } from "better-auth";

/**
 * Session lifetime tuning, kept in one place so `src/auth.ts` and the tests
 * can't drift apart.
 *
 * Sessions persist for a full year. better-auth slides the expiry forward on
 * activity: a session whose last refresh is older than
 * `SESSION_REFRESH_WINDOW_SECONDS` gets its expiry reset to the full TTL, so
 * regularly used accounts never actually hit the one-year wall.
 */
export const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 365;
export const SESSION_REFRESH_WINDOW_SECONDS = 60 * 60 * 24;

/**
 * The session cookie must be Secure when the app is served over HTTPS. The
 * scheme is taken from BETTER_AUTH_URL (the URL the app is actually served
 * from); without an explicit URL we fall back to NODE_ENV.
 *
 * Deriving this from NODE_ENV alone breaks production deployments served over
 * plain HTTP: the browser silently drops a Secure cookie on an http:// origin
 * and the user can never stay signed in.
 */
export function isSecureCookie(): boolean {
  const url = (process.env.BETTER_AUTH_URL ?? "").trim();
  if (url) return url.toLowerCase().startsWith("https://");
  return process.env.NODE_ENV === "production";
}

type CookieAttributes = NonNullable<
  NonNullable<BetterAuthOptions["advanced"]>["defaultCookieAttributes"]
>;

/**
 * Attributes better-auth applies to every cookie it writes, session cookie
 * included.
 *
 * `sameSite` must stay `"lax"` (better-auth's own default) rather than
 * `"strict"`: launching an installed app is a cross-site top-level navigation,
 * and a Strict cookie is withheld on it. The app would then read no session on
 * every cold start and bounce the user back to the login screen. Lax still
 * withholds the cookie from cross-site subrequests and state-changing requests,
 * so it keeps the CSRF protection Strict was reached for.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie#samesitesamesite-value
 */
export function sessionCookieAttributes(): CookieAttributes {
  return { sameSite: "lax", secure: isSecureCookie() };
}
