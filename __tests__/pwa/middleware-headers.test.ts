import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { NextRequest } from "next/server";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DOWNLOAD_PREFIXES } from "@/lib/download-prefixes";
import { middleware } from "@/middleware";

const API_DIR = path.join(process.cwd(), "src/app/api");

/** `/…/src/app/api/chat/attachments/[id]/route.ts` for `/api/chat/attachments/[id]`. */
function routePathOf(routeFile: string): string {
  return `/api${routeFile.slice(API_DIR.length).replace(/[\\/]route\.ts$/, "")}`;
}

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

afterEach(() => {
  vi.unstubAllEnvs();
});

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

  it("frames its own pages and the object URL a PDF preview makes", async () => {
    const csp = (await headersFor("/dashboard/files")).get("Content-Security-Policy");

    expect(csp).toContain("frame-src 'self' blob:");
  });
});

describe("scripts", () => {
  it("allows eval while `next dev` runs, even when NODE_ENV says production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("__NEXT_DEV_SERVER", "1");
    expect((await headersFor("/dashboard/chat")).get("Content-Security-Policy")).toContain(
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    );
  });

  it("drops eval from a production build", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("__NEXT_DEV_SERVER", "");
    const csp = (await headersFor("/dashboard/chat")).get("Content-Security-Policy");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("allows eval in a test or development run", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("__NEXT_DEV_SERVER", "");
    expect((await headersFor("/dashboard/chat")).get("Content-Security-Policy")).toContain(
      "unsafe-eval",
    );
  });
});

describe("framing", () => {
  it("never lets another page frame Saale, with or without previews", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://saale.example.com");
    vi.stubEnv("PREVIEW_DOMAIN", "");

    const csp = (await headersFor("/dashboard/coder/p/c")).get("Content-Security-Policy");
    expect(csp).toContain("frame-ancestors 'none'");

    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3630");
    const local = (await headersFor("/dashboard/coder/p/c")).get("Content-Security-Policy");
    expect(local).toContain("frame-ancestors 'none'");
  });

  // WebKit reads these before it decides a response is a download, so a refusal
  // here is a download button that quietly does nothing in Safari.
  it("lets this origin frame the files it downloads", async () => {
    for (const path of [
      "/api/files/raw?target=t&path=a.png&download=1",
      "/api/files/zip?target=t&path=a.png",
      "/api/chat/attachments/abc",
      "/api/chat/workspace-files?file=a.png&download=1",
      "/api/calendar/export?from=2026-01-01",
    ]) {
      const headers = await headersFor(path);
      expect(headers.get("X-Frame-Options"), path).toBe("SAMEORIGIN");
      expect(headers.get("Content-Security-Policy"), path).toContain("frame-ancestors 'self'");
    }
  });

  it("keeps other origins, and every other response, out", async () => {
    expect((await headersFor("/api/files/list?target=t")).get("X-Frame-Options")).toBe("DENY");
    expect((await headersFor("/dashboard/files")).get("X-Frame-Options")).toBe("DENY");
  });

  // The list is what makes a download work in Safari, and a route added without
  // it is a button that only fails on some browsers. Read the routes instead.
  it("registers every route that can send a download", async () => {
    const routes = (await readdir(API_DIR, { recursive: true })).filter((file) =>
      file.endsWith("route.ts"),
    );
    const unregistered: string[] = [];

    for (const route of routes) {
      const absolute = path.join(API_DIR, route);
      const source = await readFile(absolute, "utf8");
      // A streamed file and a `Content-Disposition` are the two ways a route
      // hands bytes to the browser's download machinery.
      const serves = /contentDisposition\(|Content-Disposition|streamedFileResponse\(/.test(source);
      if (!serves) continue;

      const routePath = routePathOf(absolute);
      const registered = DOWNLOAD_PREFIXES.some((prefix) => routePath.startsWith(prefix));
      if (!registered) unregistered.push(routePath.replace(/\[[^\]]+\]/g, "x"));
    }

    expect(unregistered).toEqual([]);
  });
});
