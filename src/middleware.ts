import { NextRequest, NextResponse } from "next/server";
import { isRateLimited } from "@/lib/redis";

function getRateLimitKey(request: NextRequest): string {
  // Use IP address as the rate limit key
  const reqWithIp = request as NextRequest & { ip?: string };
  const ip =
    reqWithIp.ip ??
    request.headers.get("x-forwarded-for") ??
    request.headers.get("x-real-ip") ??
    "unknown";
  return `${ip}:${request.nextUrl.pathname}`;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Rate limiting for API routes (Redis-backed, works across instances)
  if (pathname.startsWith("/api/")) {
    if (await isRateLimited(getRateLimitKey(request))) {
      return new NextResponse(JSON.stringify({ error: "Too many requests. Try again later." }), {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "60",
        },
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
      "script-src 'self' 'unsafe-inline'",
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
