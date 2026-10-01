import { expect, test, type Page } from "@playwright/test";

/**
 * PWA installability + offline fallback, against the real server.
 *
 * The unit suite covers the manifest object and the worker's logic in isolation;
 * this checks what the browser actually receives — served headers, the icon
 * files, the `<head>` wiring, and a navigation that fails for real.
 */

const REQUIRED_ICON_SIZES = ["192x192", "512x512"];

/** Pathnames currently held in Cache Storage, across every cache. */
async function cachedPathnames(page: Page) {
  return page.evaluate(async () => {
    const names = await caches.keys();
    const perCache = await Promise.all(
      names.map(async (name) => {
        const cache = await caches.open(name);
        const requests = await cache.keys();
        return requests.map((request) => new URL(request.url).pathname);
      }),
    );
    return perCache.flat();
  });
}

/**
 * Waits until the worker controls the page *and* has finished precaching the
 * offline page — registering and precaching are separate async steps, and going
 * offline in between would just exercise the inline fallback instead.
 */
async function waitForOfflineCapable(page: Page) {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
    timeout: 20_000,
  });
  await page.waitForFunction(
    async () => {
      const names = await caches.keys();
      for (const name of names) {
        const cache = await caches.open(name);
        const requests = await cache.keys();
        if (requests.some((request) => new URL(request.url).pathname === "/offline")) {
          return true;
        }
      }
      return false;
    },
    undefined,
    { timeout: 20_000 },
  );
}

test.describe("web app manifest", () => {
  test("is served with everything a browser needs to install the app", async ({ request }) => {
    const response = await request.get("/manifest.webmanifest");
    expect(response.status()).toBe(200);

    const manifest = await response.json();
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);

    const sizes = (manifest.icons as { sizes: string; purpose?: string }[]).map(
      (icon) => icon.sizes,
    );
    for (const required of REQUIRED_ICON_SIZES) {
      expect(sizes).toContain(required);
    }
  });

  test("serves every icon it advertises", async ({ request }) => {
    const manifest = await (await request.get("/manifest.webmanifest")).json();

    for (const icon of manifest.icons as { src: string }[]) {
      const iconResponse = await request.get(icon.src);
      expect(iconResponse.status(), `${icon.src} should be reachable`).toBe(200);
      expect(iconResponse.headers()["content-type"]).toContain("image/png");
    }
  });
});

test.describe("document head", () => {
  test("links the manifest and declares an installed-app-capable viewport", async ({ page }) => {
    await page.goto("/auth/login");

    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
      "href",
      /manifest\.webmanifest/,
    );

    const viewport = await page.locator('meta[name="viewport"]').getAttribute("content");
    expect(viewport).toContain("width=device-width");
    expect(viewport).toContain("viewport-fit=cover");

    // Scheme-aware browser chrome colour.
    const themeColors = await page.locator('meta[name="theme-color"]').evaluateAll((nodes) =>
      nodes.map((node) => ({
        media: node.getAttribute("media"),
        content: node.getAttribute("content"),
      })),
    );
    expect(themeColors.map((entry) => entry.media)).toEqual(
      expect.arrayContaining(["(prefers-color-scheme: light)", "(prefers-color-scheme: dark)"]),
    );
    for (const entry of themeColors) {
      expect(entry.content).toMatch(/^#[0-9a-f]{6}$/i);
    }

    // iOS reads these instead of the manifest.
    await expect(page.locator('meta[name="mobile-web-app-capable"]')).toHaveAttribute(
      "content",
      "yes",
    );
    await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute(
      "content",
      "yes",
    );
    await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute(
      "content",
      "Saale",
    );
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
    await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute("href", /.+/);
  });
});

test.describe("service worker", () => {
  test("is served uncacheable so deployments reach installed clients", async ({ request }) => {
    const response = await request.get("/sw.js");

    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("javascript");
    expect(response.headers()["cache-control"]).toContain("no-store");
  });

  test("registers, activates, precaches the offline page and takes control", async ({ page }) => {
    await page.goto("/auth/login");
    await waitForOfflineCapable(page);

    expect(await cachedPathnames(page)).toContain("/offline");
  });

  test("serves the precached offline page when a navigation fails", async ({ page, context }) => {
    await page.goto("/auth/login");
    await waitForOfflineCapable(page);

    await context.setOffline(true);
    try {
      await page.goto("/dashboard/chat");
      await expect(page.getByRole("heading", { name: /you're offline/i })).toBeVisible();
      await expect(page.getByRole("button", { name: /try again/i })).toBeVisible();
    } finally {
      await context.setOffline(false);
    }
  });

  test("never caches authenticated API responses", async ({ page }) => {
    await page.goto("/auth/login");
    await waitForOfflineCapable(page);

    await page.evaluate(() => fetch("/api/signups/enabled").then((response) => response.status));

    const cached = await cachedPathnames(page);
    expect(cached.filter((path) => path.startsWith("/api/"))).toEqual([]);
  });
});
