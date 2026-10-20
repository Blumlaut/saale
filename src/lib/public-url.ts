/**
 * The URL Saale is reachable at from outside, used wherever a third party must
 * send a browser back to us. OAuth redirect URIs today.
 *
 * `BETTER_AUTH_URL` is the canonical value: it is the URL the app is actually
 * served from, the same one better-auth derives its cookie scheme from. The
 * fallbacks cover deployments that only set an older variable.
 */
export function getPublicUrl(): string {
  const candidates = [
    process.env.BETTER_AUTH_URL,
    process.env.NEXT_PUBLIC_BASE_URL,
    process.env.APP_URL,
  ];

  for (const candidate of candidates) {
    const url = candidate?.trim();
    if (url) return url.replace(/\/+$/, "");
  }

  // A redirect URI that cannot be reached only fails an OAuth sign-in, so a
  // local default is safer than throwing inside a request handler.
  return "http://localhost:3630";
}
