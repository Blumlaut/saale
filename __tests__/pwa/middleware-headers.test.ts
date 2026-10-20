import { NextRequest } from "next/server";

import { describe, expect, it } from "vitest";

import { middleware } from "@/middleware";

/**
 * The service worker only installs if the CSP lets a same-origin worker load,
 * and it only updates if the browser is allowed to revalidate `/sw.js`  a
 * cached worker script would pin installed clients to a stale deployment.
 */

function request(path: string) {
  return new NextRequest(new URL(path, "http://localhost"));
}

async function headersFor(path: string) {
  const response = await middleware(request(path));
  return response.headers;
}

describe("PWA response headers", () => {
  it("allows a same-origin service worker and manifest", async () => {
    const csp = (await headersFor("/dashboard/chat")).get("Content-Security-Policy");

    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("manifest-src 'self'");
  });

  it("keeps serving the manifest from the app origin", async () => {
    const headers = await headersFor("/manifest.webmanifest");

    expect(headers.get("Content-Security-Policy")).toContain("manifest-src 'self'");
  });

  it("never lets the service worker script be cached", async () => {
    const headers = await headersFor("/sw.js");

    expect(headers.get("Cache-Control")).toBe("no-cache, no-store, must-revalidate");
    expect(headers.get("Content-Type")).toBe("application/javascript; charset=utf-8");
  });

  it("leaves ordinary responses out of the service worker cache rule", async () => {
    const headers = await headersFor("/dashboard/chat");

    expect(headers.get("Cache-Control")).toBeNull();
  });

  it("still applies the baseline security headers", async () => {
    const headers = await headersFor("/offline");

    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("X-Frame-Options")).toBe("DENY");
  });
});
