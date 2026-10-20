import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

import { describe, expect, it, vi } from "vitest";

/**
 * Behavioural tests for `public/sw.js`.
 *
 * The worker is loaded into a `node:vm` context with stand-ins for the service
 * worker globals (`self`, `caches`, `fetch`, `Response`) so the real script runs
 * unmodified. What matters here is the safety contract: authenticated API
 * responses and page navigations must never be cached, and the offline fallback
 * must actually appear when the network dies.
 */

const SW_SOURCE = readFileSync(join(__dirname, "../../public/sw.js"), "utf8");

const CHUNK_JS = "/_next/static/chunks/app.js";
const CHUNK_CSS = "/_next/static/chunks/app.css";
const FONT = "/_next/static/media/inter.woff2";
const OFFLINE_PAGE_HTML = `<html><head><link rel="stylesheet" href="${CHUNK_CSS}"></head><body><h1>You&#x27;re offline</h1><script src="${CHUNK_JS}"></script></body></html>`;
const STYLESHEET = `@font-face{src:url(${FONT})}`;

/** Minimal `Response`  the worker only touches status, ok, headers, clone() and text(). */
class FakeResponse {
  readonly status: number;
  readonly headers: Record<string, string>;

  constructor(
    private readonly body: string,
    init: { status?: number; headers?: Record<string, string> } = {},
  ) {
    this.status = init.status ?? 200;
    this.headers = init.headers ?? {};
  }

  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  clone(): FakeResponse {
    return new FakeResponse(this.body, { status: this.status, headers: this.headers });
  }

  text(): Promise<string> {
    return Promise.resolve(this.body);
  }
}

type CacheKey = string | { url: string };

interface FetchEventRequest {
  method: string;
  url: string;
  mode: string;
}

interface HarnessOptions {
  mode: string;
  /** Resolves a request to a response; rejecting simulates being offline. */
  network?: (url: string) => Promise<FakeResponse> | FakeResponse;
}

/** The pages and assets a healthy deployment serves. */
function siteNetwork(url: string): FakeResponse {
  if (url === "/offline") return new FakeResponse(OFFLINE_PAGE_HTML);
  if (url === CHUNK_CSS) return new FakeResponse(STYLESHEET);
  return new FakeResponse("asset");
}

function createHarness({ mode, network = siteNetwork }: HarnessOptions) {
  const listeners = new Map<string, (event: never) => void>();
  const cacheStores = new Map<string, Map<string, FakeResponse>>();
  const fetched: string[] = [];
  const errors: unknown[][] = [];

  /** String keys and request-like keys resolve to the same cache entry. */
  const normalise = (key: CacheKey): string =>
    typeof key === "string" ? key : new URL(key.url).pathname;

  const storeFor = (name: string): Map<string, FakeResponse> => {
    let store = cacheStores.get(name);
    if (!store) {
      store = new Map();
      cacheStores.set(name, store);
    }
    return store;
  };

  const caches = {
    open: async (name: string) => {
      const store = storeFor(name);
      return {
        put: async (key: CacheKey, value: FakeResponse) => {
          store.set(normalise(key), value);
        },
        match: async (key: CacheKey) => store.get(normalise(key)),
        keys: async () => [...store.keys()],
        delete: async (key: CacheKey) => store.delete(normalise(key)),
      };
    },
    match: async (key: CacheKey) => {
      for (const store of cacheStores.values()) {
        const hit = store.get(normalise(key));
        if (hit) return hit;
      }
      return undefined;
    },
    keys: async () => [...cacheStores.keys()],
    delete: async (name: string) => cacheStores.delete(name),
  };

  const fetchStub = vi.fn(async (input: string | { url: string }) => {
    const url = typeof input === "string" ? input : input.url;
    fetched.push(url);
    return network(url);
  });

  const self = {
    location: { href: `http://localhost/sw.js?mode=${mode}`, origin: "http://localhost" },
    addEventListener: (type: string, handler: (event: never) => void) => {
      listeners.set(type, handler);
    },
    skipWaiting: vi.fn(async () => {}),
    clients: { claim: vi.fn(async () => {}) },
  };

  const consoleStub = {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn((...args: unknown[]) => {
      errors.push(args);
    }),
  };

  const context = vm.createContext({
    self,
    caches,
    fetch: fetchStub,
    console: consoleStub,
    Response: FakeResponse,
    URL,
  });
  vm.runInContext(SW_SOURCE, context);

  async function lifecycle(type: "install" | "activate") {
    const pending: Promise<unknown>[] = [];
    const handler = listeners.get(type);
    if (!handler) throw new Error(`No ${type} listener registered`);

    handler({
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    } as never);
    await Promise.all(pending);
  }

  async function dispatchFetch(request: FetchEventRequest) {
    const holder: { response: Promise<unknown> | null } = { response: null };
    const handler = listeners.get("fetch");
    if (!handler) throw new Error("No fetch listener registered");

    handler({
      request,
      respondWith: (value: unknown) => {
        holder.response = Promise.resolve(value);
      },
    } as never);

    return {
      intercepted: holder.response !== null,
      response: holder.response === null ? null : await holder.response,
    };
  }

  return {
    errors,
    fetchStub,
    cacheStores,
    skipWaiting: self.skipWaiting,
    claim: self.clients.claim,
    lifecycle,
    dispatchFetch,
    cachedUrls: (name: string) => [...(cacheStores.get(name)?.keys() ?? [])],
    seedCache: (name: string, entries: Record<string, FakeResponse>) => {
      const store = storeFor(name);
      for (const [key, value] of Object.entries(entries)) store.set(key, value);
    },
  };
}

const navigation = (path: string): FetchEventRequest => ({
  method: "GET",
  url: `http://localhost${path}`,
  mode: "navigate",
});

const asset = (path: string): FetchEventRequest => ({
  method: "GET",
  url: `http://localhost${path}`,
  mode: "no-cors",
});

describe("service worker install", () => {
  it("precaches the offline page and its whole asset closure", async () => {
    const harness = createHarness({ mode: "production" });

    await harness.lifecycle("install");

    expect(harness.cachedUrls("saale-static-1").sort()).toEqual(
      ["/offline", CHUNK_CSS, CHUNK_JS, FONT].sort(),
    );
    expect(harness.skipWaiting).toHaveBeenCalled();
  });

  it("still activates when precaching fails, and says why", async () => {
    const harness = createHarness({
      mode: "production",
      network: () => Promise.reject(new Error("offline")),
    });

    await expect(harness.lifecycle("install")).resolves.toBeUndefined();

    expect(harness.errors.length).toBeGreaterThan(0);
  });
});

describe("service worker activate", () => {
  it("drops only its own caches from earlier versions, and claims open clients", async () => {
    const harness = createHarness({ mode: "production" });
    harness.seedCache("saale-static-0", { "/stale": new FakeResponse("old") });
    harness.seedCache("unrelated-cache", { "/keep": new FakeResponse("keep") });

    await harness.lifecycle("activate");

    expect(harness.cacheStores.has("saale-static-0")).toBe(false);
    expect(harness.cacheStores.has("unrelated-cache")).toBe(true);
    expect(harness.claim).toHaveBeenCalled();
  });
});

describe("service worker fetch safety", () => {
  it("never touches authenticated API traffic", async () => {
    const harness = createHarness({ mode: "production" });

    const result = await harness.dispatchFetch(navigation("/api/settings"));

    expect(result.intercepted).toBe(false);
    expect(harness.fetchStub).not.toHaveBeenCalled();
  });

  it("ignores non-GET requests", async () => {
    const harness = createHarness({ mode: "production" });

    const result = await harness.dispatchFetch({
      method: "POST",
      url: "http://localhost/dashboard/chat",
      mode: "navigate",
    });

    expect(result.intercepted).toBe(false);
  });

  it("ignores cross-origin requests", async () => {
    const harness = createHarness({ mode: "production" });

    const result = await harness.dispatchFetch({
      method: "GET",
      url: "https://example.com/tracker.js",
      mode: "no-cors",
    });

    expect(result.intercepted).toBe(false);
  });

  it("passes a healthy navigation straight through without caching it", async () => {
    const harness = createHarness({
      mode: "production",
      network: () => new FakeResponse("<html>dashboard</html>"),
    });

    const result = await harness.dispatchFetch(navigation("/dashboard/chat"));

    expect(result.intercepted).toBe(true);
    expect(await (result.response as FakeResponse).text()).toBe("<html>dashboard</html>");
    expect(harness.cachedUrls("saale-static-1")).not.toContain("/dashboard/chat");
  });

  it("serves the precached offline page when a navigation fails", async () => {
    const offline = createHarness({
      mode: "production",
      network: (url) => {
        throw new Error(`cannot reach ${url}`);
      },
    });

    // Warm the cache the way a real install does, then go offline.
    const online = createHarness({ mode: "production" });
    await online.lifecycle("install");
    for (const [key, value] of online.cacheStores.get("saale-static-1") ?? []) {
      offline.seedCache("saale-static-1", { [key]: value });
    }

    const result = await offline.dispatchFetch(navigation("/dashboard/mail"));

    expect(result.intercepted).toBe(true);
    expect(await (result.response as FakeResponse).text()).toBe(OFFLINE_PAGE_HTML);
    expect(offline.errors.length).toBeGreaterThan(0);
  });

  it("falls back to an inline page when nothing was ever cached", async () => {
    const harness = createHarness({
      mode: "production",
      network: () => Promise.reject(new Error("offline")),
    });

    const result = await harness.dispatchFetch(navigation("/dashboard/chat"));

    expect(result.intercepted).toBe(true);
    expect(await (result.response as FakeResponse).text()).toContain("You're offline");
  });
});

describe("service worker asset caching", () => {
  it("serves cached build assets without hitting the network", async () => {
    const harness = createHarness({ mode: "production", network: () => new FakeResponse("fresh") });
    harness.seedCache("saale-static-1", { [CHUNK_JS]: new FakeResponse("cached") });

    const result = await harness.dispatchFetch(asset(CHUNK_JS));

    expect(await (result.response as FakeResponse).text()).toBe("cached");
    expect(harness.fetchStub).not.toHaveBeenCalled();
  });

  it("caches build assets it has not seen before", async () => {
    const harness = createHarness({ mode: "production", network: () => new FakeResponse("fresh") });

    await harness.dispatchFetch(asset(CHUNK_JS));

    expect(harness.cachedUrls("saale-static-1")).toContain(CHUNK_JS);
  });

  it("leaves assets alone in development, where chunk URLs are rewritten in place", async () => {
    const harness = createHarness({ mode: "development", network: () => new FakeResponse("dev") });
    harness.seedCache("saale-static-1", { [CHUNK_JS]: new FakeResponse("stale") });

    const result = await harness.dispatchFetch(asset(CHUNK_JS));

    expect(result.intercepted).toBe(false);
  });
});
