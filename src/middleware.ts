import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";

/**
 * Simple in-memory rate limiter.
 * In production, use Redis for distributed rate limiting.
 */
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 60; // requests per window

function getRateLimitKey(request: NextRequest): string {
  // Use IP address as the rate limit key
  // `ip` is available on NextRequest in Next.js 15+ but not typed in older versions
  const reqWithIp = request as NextRequest & { ip?: string };
  const ip =
    reqWithIp.ip ??
    request.headers.get("x-forwarded-for") ??
    request.headers.get("x-real-ip") ??
    "unknown";
  return `${ip}:${request.nextUrl.pathname}`;
}

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return true;
  }

  entry.count++;
  return false;
}

/** Paths that require authentication. */
const PROTECTED_PATHS = ["/dashboard"];

/** Paths that are public (auth pages, API auth handler). */
const PUBLIC_PATHS = ["/auth", "/api/auth"];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Rate limiting for API routes
  if (pathname.startsWith("/api/")) {
    if (isRateLimited(getRateLimitKey(request))) {
      return new NextResponse(JSON.stringify({ error: "Too many requests. Try again later." }), {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "60",
        },
      });
    }
  }

  // Auth check for protected paths
  const isProtected = PROTECTED_PATHS.some((p) => pathname.startsWith(p));
  const isPublic = PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  if (isProtected && !isPublic) {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session) {
      // Redirect to login for non-API requests
      if (!pathname.startsWith("/api/")) {
        const loginUrl = new URL("/auth/login", request.url);
        loginUrl.searchParams.set("callbackUrl", pathname);
        return NextResponse.redirect(loginUrl);
      }
      // Return 401 for API requests
      return new NextResponse(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // Add security headers to all responses
  const response = NextResponse.next();

  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-XSS-Protection", "1; mode=block");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  // Content Security Policy
  response.headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  );

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
