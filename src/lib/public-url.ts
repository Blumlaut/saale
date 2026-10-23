/**
 * The URL Saale is reachable at from outside, used wherever a third party must
 * send a browser or a bot back to us (OAuth redirect URIs, the Telegram
 * webhook).
 *
 * `BETTER_AUTH_URL` is the single source: it is the URL the app is actually
 * served from, the same one better-auth derives its cookie scheme from.
 */
export function getPublicUrl(): string {
  const url = (process.env.BETTER_AUTH_URL ?? "").trim();
  if (url) return url.replace(/\/+$/, "");

  // A redirect URI that cannot be reached only fails an OAuth sign-in, so a
  // local default is safer than throwing inside a request handler.
  return "http://localhost:3630";
}
