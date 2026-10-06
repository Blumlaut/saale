/**
 * Pi's model-catalog overlay, cached in Redis and refreshed in the background.
 *
 * Pi publishes a model catalog per provider at `pi.dev`, so a provider's model
 * list stays current between package releases — that is how the Pi CLI knows
 * about a model that shipped after it was installed. Pi looks for the overlay
 * in a `ModelsStore`, which it restores on every runtime creation and rewrites
 * when a refresh succeeds.
 *
 * Saale keeps that store in Redis rather than in Pi's own directory
 * (`~/.pi/agent/models-store.json` belongs to whoever installed Pi on the
 * host), which also shares one catalog across every Saale process and tenant —
 * the catalog is public data, and one fetch serves everyone.
 *
 * Refreshes run detached: a request is answered from the cached overlay, and a
 * failed fetch only costs the next request its freshness.
 */

import type {
  ModelsStore,
  ModelsStoreEntry,
  ModelsStoreOperationOptions,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { getRedis } from "@/lib/redis";

/** Redis key prefix per provider, e.g. `pi-models-store:anthropic`. */
const STORE_PREFIX = "pi-models-store:";

/**
 * How long a cached catalog lives in Redis. Pi refreshes an entry at most every
 * four hours, so this only bounds garbage from providers nobody uses anymore.
 */
const STORE_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Minimum gap between two background refresh passes *in this process*. Pi also
 * skips providers whose cached catalog was checked within four hours, so this
 * only bounds the work a burst of runtime creations can trigger.
 */
const REFRESH_THROTTLE_MS = 5 * 60_000;

/**
 * How long a cached catalog may take before the request goes on without it.
 *
 * Building a runtime reads one entry per provider, and a Redis that is down (or
 * unreachable from this process) must not become a model list that never
 * arrives — Pi's built-in catalog is a complete answer, just a less current one.
 */
const STORE_TIMEOUT_MS = 1_000;

/** At most one store-failure log per interval: one request reads 40+ entries. */
const STORE_FAILURE_LOG_INTERVAL_MS = 5 * 60_000;
let lastStoreFailureLogAt = 0;

/** Report a store failure without turning one outage into a log flood. */
function logStoreFailure(context: string, err: unknown): void {
  const now = Date.now();
  if (now - lastStoreFailureLogAt < STORE_FAILURE_LOG_INTERVAL_MS) return;
  lastStoreFailureLogAt = now;
  console.error(`${context} — using Pi's built-in catalog:`, err);
}

/**
 * Run a cache operation, resolving `undefined` if it fails or takes too long.
 *
 * Every caller treats a missing entry as "no cached catalog", which is what an
 * unreachable cache means.
 */
function cached<T>(operation: Promise<T>, context: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), STORE_TIMEOUT_MS);
    // Never hold the process open for a cache read.
    timer.unref?.();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        logStoreFailure(context, err);
        resolve(undefined);
      },
    );
  });
}

/** Shared, process-wide Redis-backed catalog store. */
export function createModelsStore(): ModelsStore {
  return {
    async read(providerId: string, options?: ModelsStoreOperationOptions) {
      options?.signal?.throwIfAborted();
      const raw = await cached(
        getRedis().get(`${STORE_PREFIX}${providerId}`),
        `Failed to read the cached model catalog for ${providerId}`,
      );
      if (!raw) return undefined;
      try {
        return JSON.parse(raw) as ModelsStoreEntry;
      } catch (err) {
        // A corrupted entry must not disable the provider's models: dropping it
        // falls back to Pi's built-in catalog.
        console.error(`Failed to parse the cached model catalog for ${providerId}:`, err);
        return undefined;
      }
    },

    async write(
      providerId: string,
      entry: ModelsStoreEntry,
      options?: ModelsStoreOperationOptions,
    ) {
      options?.signal?.throwIfAborted();
      await cached(
        getRedis().set(
          `${STORE_PREFIX}${providerId}`,
          JSON.stringify(entry),
          "EX",
          STORE_TTL_SECONDS,
        ),
        `Failed to cache the model catalog for ${providerId}`,
      );
    },

    async delete(providerId: string, options?: ModelsStoreOperationOptions) {
      options?.signal?.throwIfAborted();
      await cached(
        getRedis().del(`${STORE_PREFIX}${providerId}`),
        `Failed to drop the cached model catalog for ${providerId}`,
      );
    },
  };
}

/** Last background refresh started in this process (throttle, not a cache). */
let lastRefreshAt = 0;

/**
 * Refresh the configured providers' catalogs without blocking the caller.
 *
 * Only providers with a credential are fetched — Pi skips the network phase for
 * unconfigured ones — so this costs one request per provider the user actually
 * uses, and only when Pi's own four-hour freshness window has passed.
 *
 * `PI_OFFLINE` (Pi's switch for running without model-catalog network access)
 * disables it here too, since Pi only consults that variable on `create()`.
 */
export function refreshModelCatalogInBackground(modelRuntime: ModelRuntime): void {
  if (process.env.PI_OFFLINE !== undefined) return;

  const now = Date.now();
  if (now - lastRefreshAt < REFRESH_THROTTLE_MS) return;
  lastRefreshAt = now;

  void modelRuntime
    .refresh({ allowNetwork: true })
    .then((result) => {
      for (const [providerId, error] of result.errors) {
        // A provider whose catalog could not be fetched keeps its cached or
        // built-in models; report it rather than failing the caller.
        console.error(`Failed to refresh the model catalog for ${providerId}:`, error);
      }
    })
    .catch((err) => {
      console.error("Failed to refresh model catalogs:", err);
    });
}
