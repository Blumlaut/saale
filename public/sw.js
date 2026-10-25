/**
 * Saale service worker.
 *
 * Scope is deliberately narrow. Saale's dashboard is authenticated and
 * live-data, so this worker never caches navigations or API responses: a cached
 * dashboard page would serve one user's mail/chat state to the next session on a
 * shared device. All it does is:
 *
 *   1. Offline fallback — a navigation that fails resolves to the precached
 *      `/offline` page instead of the browser's error page.
 *   2. Production asset caching — `/_next/static/*` is content-hashed and served
 *      immutably by Next.js, so it is safe to serve cache-first. This is what
 *      lets the precached offline page render with its real styles and fonts.
 *   3. Push notifications — a message from Saale's server is rendered as a
 *      system notification, and clicking it opens the page it is about.
 *
 * The offline page's asset closure is discovered at install time by reading the
 * rendered HTML (and the stylesheets it references), so there is no build-time
 * manifest to keep in sync.
 */

const CACHE_VERSION = "1";
const CACHE_PREFIX = "saale-static-";
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;

const OFFLINE_URL = "/offline";
const STATIC_ASSET_PREFIX = "/_next/static/";

/**
 * Turbopack rewrites development chunk URLs in place, so caching them would
 * serve stale code after an edit. The registrar appends the mode, and dev runs
 * fall back to the network for assets while keeping the offline fallback.
 */
const IS_DEVELOPMENT = new URL(self.location.href).searchParams.get("mode") === "development";

/** Bound on cached asset entries so repeated deployments cannot grow unbounded. */
const MAX_STATIC_ENTRIES = 300;

/** Absolute URLs of emitted assets, as they appear in HTML and CSS. */
const ASSET_PATTERN = /\/_next\/static\/[^"'\\\s<>)]+/g;

/** Rendered only if the offline page could not be precached. */
const FALLBACK_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Offline · Saale</title>
<style>
body{margin:0;display:flex;min-height:100dvh;align-items:center;justify-content:center;
background:#0b0b0c;color:#f5f5f7;font:15px/1.5 system-ui,sans-serif;text-align:center;padding:2rem}
p{color:#a7a7a9;max-width:28rem}
</style></head>
<body><main><h1>You're offline</h1>
<p>Saale needs a connection. Check your network and try again.</p></main></body></html>`;

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request for ${url} failed with ${response.status}`);
  }
  return response.text();
}

/** Every `/_next/static/*` URL the offline page needs, stylesheet imports included. */
async function collectOfflineAssets(html) {
  const urls = new Set(html.match(ASSET_PATTERN) ?? []);

  const stylesheets = [...urls].filter((url) => url.endsWith(".css"));
  const sheets = await Promise.all(
    stylesheets.map(async (url) => {
      try {
        return await fetchText(url);
      } catch (error) {
        console.error(`Failed to read stylesheet ${url} while precaching:`, error);
        return "";
      }
    }),
  );
  for (const sheet of sheets) {
    for (const url of sheet.match(ASSET_PATTERN) ?? []) {
      urls.add(url);
    }
  }

  return [...urls];
}

async function precacheOfflinePage() {
  const cache = await caches.open(CACHE_NAME);
  // `reload` bypasses the HTTP cache so a redeploy cannot precache stale HTML.
  const response = await fetch(OFFLINE_URL, { cache: "reload" });
  if (!response.ok) {
    throw new Error(`Offline page request failed with ${response.status}`);
  }
  const html = await response.clone().text();
  await cache.put(OFFLINE_URL, response);

  for (const url of await collectOfflineAssets(html)) {
    try {
      const assetResponse = await fetch(url, { cache: "reload" });
      if (assetResponse.ok) {
        await cache.put(url, assetResponse);
      }
    } catch (error) {
      console.error(`Failed to precache asset ${url}:`, error);
    }
  }
}

/** Drops the oldest entries once the cache exceeds its bound. */
async function trimCache(cache) {
  const keys = await cache.keys();
  if (keys.length <= MAX_STATIC_ENTRIES) return;

  const excess = keys.length - MAX_STATIC_ENTRIES;
  for (const key of keys.slice(0, excess)) {
    await cache.delete(key);
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      try {
        await precacheOfflinePage();
      } catch (error) {
        // A network hiccup must not strand the worker in "installing" forever —
        // the inline fallback still covers offline navigations.
        console.error("Failed to precache the offline page:", error);
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

async function offlineFallback() {
  const cached = await caches.match(OFFLINE_URL);
  if (cached) return cached;

  return new Response(FALLBACK_HTML, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function navigateWithOfflineFallback(request) {
  try {
    return await fetch(request);
  } catch (error) {
    console.error("Navigation failed, serving the offline page:", error);
    return offlineFallback();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) {
    try {
      await cache.put(request, response.clone());
      await trimCache(cache);
    } catch (error) {
      console.error(`Failed to cache ${request.url}:`, error);
    }
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Authenticated per-user data — never cached, never served stale.
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(navigateWithOfflineFallback(request));
    return;
  }

  if (!IS_DEVELOPMENT && url.pathname.startsWith(STATIC_ASSET_PREFIX)) {
    event.respondWith(cacheFirst(request));
  }
});

/**
 * Whether the app is on screen right now. A visible window already shows a
 * reply arriving, so a system banner on top of it is noise.
 */
async function appIsVisible() {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return windows.some((client) => client.visibilityState === "visible");
}

async function showPushNotification(payload) {
  if (!payload || typeof payload.title !== "string") {
    console.error("Push message without a title:", payload);
    return;
  }

  try {
    if (await appIsVisible()) return;
  } catch (error) {
    // Rendering the notification matters more than the visibility check.
    console.error("Failed to check for a visible window:", error);
  }

  await self.registration.showNotification(payload.title, {
    body: typeof payload.body === "string" ? payload.body : "",
    tag: typeof payload.tag === "string" ? payload.tag : "saale",
    data: { url: typeof payload.url === "string" ? payload.url : "/" },
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
  });
}

self.addEventListener("push", (event) => {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch (error) {
    console.error("Push message was not JSON:", error);
  }
  event.waitUntil(showPushNotification(payload));
});

/** Focus the app on the page the notification is about, or open it. */
async function openNotificationTarget(target) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

  for (const client of windows) {
    if (!client.url.startsWith(self.location.origin)) continue;

    await client.focus();
    if (client.url !== target) {
      await client.navigate(target).catch((error) => {
        console.error(`Failed to navigate the app to ${target}:`, error);
      });
    }
    return;
  }

  await self.clients.openWindow(target);
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = event.notification.data && event.notification.data.url;
  const target = new URL(typeof path === "string" ? path : "/", self.location.origin).href;

  event.waitUntil(
    openNotificationTarget(target).catch((error) => {
      console.error("Failed to open the notification target:", error);
    }),
  );
});
