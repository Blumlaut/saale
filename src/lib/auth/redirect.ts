/**
 * Where a signed-out visitor was going, so signing in does not dump them on the
 * dashboard. The path rides along in `?next=`, which makes it caller-controlled
 * and therefore an open redirect until `safeNextPath` has had a look at it.
 */

/**
 * Request header the middleware stamps with the path a render was reached on.
 * Server layouts cannot read the URL, and this is the only place they can learn
 * the whole path including the query.
 */
export const PATH_HEADER = "x-saale-path";

/** Login URL that returns to `path` once the visitor is signed in. */
export function loginPath(path: string): string {
  return `/auth/login?next=${encodeURIComponent(path)}`;
}

/**
 * The local path in a `?next=`, or null.
 *
 * Absolute URLs, protocol-relative URLs and the backslash forms a browser
 * normalizes into them all leave this page for another site, so they are not
 * paths at all.
 */
export function safeNextPath(next: string | null | undefined): string | null {
  if (!next || next.includes("\\") || !next.startsWith("/") || next.startsWith("//")) {
    return null;
  }

  let url: URL;
  try {
    // The base only resolves the path; anything that escapes it changes origin.
    url = new URL(next, "http://saale.invalid");
  } catch (err) {
    console.error(`Could not parse redirect target ${next}:`, err);
    return null;
  }

  if (url.origin !== "http://saale.invalid") return null;
  return `${url.pathname}${url.search}${url.hash}`;
}
