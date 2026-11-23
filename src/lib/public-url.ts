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

/** Whether a URL names this machine, so nothing outside it can send a browser there. */
function isLocalUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch (err) {
    console.error(`"${url}" is not a URL, so it cannot name this instance:`, err);
    return false;
  }
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "[::1]" ||
    /^127\./.test(host)
  );
}

/**
 * The public URL of a request, for an instance whose `BETTER_AUTH_URL` is a
 * loopback address: a redirect URI has to name the host the browser is on, and
 * a page served from a preview hostname is not on localhost.
 *
 * The request's own host is only taken when the instance already trusts it to
 * send auth requests, so a forged `Host` header cannot make Saale register
 * someone else's address as the place an authorization code is delivered.
 */
export function getRequestPublicUrl(request: Request): string {
  const configured = getPublicUrl();
  if (!isLocalUrl(configured)) return configured;

  const origin = requestOrigin(request);
  if (!origin || isLocalUrl(origin) || !isTrustedOrigin(origin)) return configured;
  return origin;
}

/** The scheme and host this request arrived with, or null when it names neither. */
function requestOrigin(request: Request): string | null {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host")?.trim() || "";
  if (!/^[A-Za-z0-9.-]+(:\d+)?$/.test(host)) return null;

  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const proto = forwardedProto || new URL(request.url).protocol.replace(":", "");
  if (proto !== "http" && proto !== "https") return null;
  return `${proto}://${host}`;
}

/** Origins that may send auth requests, the list better-auth reads. */
function trustedOrigins(): string[] {
  return (process.env.AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/** Whether an origin is trusted, where an entry may carry a wildcard host. */
function isTrustedOrigin(origin: string): boolean {
  return trustedOrigins().some((entry) => matchesOrigin(entry, origin));
}

/** `https://*.preview.example.com` covers one preview hostname under that name. */
function matchesOrigin(entry: string, origin: string): boolean {
  if (entry === origin) return true;
  const star = entry.indexOf("*");
  if (star < 0) return false;
  const prefix = entry.slice(0, star);
  const suffix = entry.slice(star + 1);
  return (
    origin.length > prefix.length + suffix.length &&
    origin.startsWith(prefix) &&
    origin.endsWith(suffix)
  );
}
