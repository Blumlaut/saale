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
