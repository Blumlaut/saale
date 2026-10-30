import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { PATH_HEADER } from "@/lib/auth/redirect";
import {
  resolveSettingsEntry,
  SETTINGS_ROOT,
  settingsSection,
} from "@/lib/navigation/settings-nav";

/**
 * Rate limiting for API routes.
 *
 * Uses an in-memory Map. this is best-effort per-instance only.
 * For cross-instance rate limiting, handle it at the reverse proxy level (nginx/Traefik).
 */
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
// The e2e suite sends every request from one address, so a run raises this.
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 60);

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

function getRateLimitKey(request: NextRequest): string {
  const reqWithIp = request as NextRequest & { ip?: string };
  const ip =
    reqWithIp.ip ??
    request.headers.get("x-forwarded-for") ??
    request.headers.get("x-real-ip") ??
    "unknown";
  return `${ip}:${request.nextUrl.pathname}`;
}

/**
 * Whether this server was started with `next dev`.
 *
 * Next's own flag, because `NODE_ENV` alone lies here: a shell that exports
 * `NODE_ENV=production` (which a local build needs) still runs `next dev` with
 * eval, and the block would only show up when someone clicks something.
 */
function isDevBuild(): boolean {
  return process.env.__NEXT_DEV_SERVER === "1" || process.env.NODE_ENV !== "production";
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Settings has no page of its own: the bare URL lands on a section, and the
  // old `?tab=` links still resolve. Done here so it is a real redirect.
  if (pathname === SETTINGS_ROOT) {
    const section = settingsSection(resolveSettingsEntry(request.nextUrl.searchParams.get("tab")));
    return NextResponse.redirect(new URL(section.href, request.url));
  }

  // Rate limiting for API routes (in-memory, best-effort per-instance)
  if (pathname.startsWith("/api/") && isRateLimited(getRateLimitKey(request))) {
    return new NextResponse(JSON.stringify({ error: "Too many requests. Try again later." }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": "60",
      },
    });
  }

  // Add security headers to all responses
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(PATH_HEADER, `${pathname}${request.nextUrl.search}`);
  const response = NextResponse.next({ request: { headers: requestHeaders } });

  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-XSS-Protection", "1; mode=block");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  // The composer records voice input; nothing here opens the camera.
  response.headers.set("Permissions-Policy", "camera=(), microphone=(self), geolocation=()");

  // Content Security Policy
  response.headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      // A dev server compiles modules with eval; a production build does not.
      isDevBuild()
        ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
        : "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https:",
      // The offline service worker and the web app manifest are same-origin.
      "worker-src 'self'",
      "manifest-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  );

  // An installed client keeps its service worker until the script changes, so
  // it must never be served from a stale cache.
  if (pathname === "/sw.js") {
    response.headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
    response.headers.set("Content-Type", "application/javascript; charset=utf-8");
  }

  return response;
}

/** Only run middleware on relevant paths. */
export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico (favicon)
     * - public folder files
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
