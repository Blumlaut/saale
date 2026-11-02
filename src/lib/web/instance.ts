/**
 * What the SearXNG instance says about itself.
 *
 * SearXNG keeps its configuration in `settings.yml`, which is read-only over
 * HTTP. `GET /config` names the engines it runs, their categories and the ones
 * it has switched off, and the admin page offers that list.
 */

import { searchInstanceUrl } from "@/lib/web/search";

/** One engine as the instance reports it. */
export interface SearchInstanceEngine {
  name: string;
  categories: string[];
  /** False when the instance's own settings switch the engine off. */
  enabled: boolean;
}

export interface SearchInstance {
  url: string;
  name: string;
  version: string;
  categories: string[];
  /** Every engine the instance knows, enabled or not, sorted by name. */
  engines: SearchInstanceEngine[];
}

/** SearXNG's `/config` body, as far as this app reads it. */
interface SearxngConfig {
  instance_name?: unknown;
  version?: unknown;
  categories?: unknown;
  engines?: unknown;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * The instance's own engine list.
 *
 * @throws {Error} When the instance does not answer or answers with something
 *   other than its configuration.
 */
export async function fetchSearchInstance(timeoutMs = 5_000): Promise<SearchInstance> {
  const url = searchInstanceUrl();

  const response = await fetch(`${url}/config`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as SearxngConfig;
  const engines: SearchInstanceEngine[] = [];

  for (const entry of Array.isArray(body.engines) ? body.engines : []) {
    const engine = entry as Record<string, unknown>;
    const name = typeof engine.name === "string" ? engine.name : "";
    if (!name) continue;
    engines.push({
      name,
      categories: stringList(engine.categories),
      enabled: engine.enabled === true,
    });
  }

  engines.sort((left, right) => left.name.localeCompare(right.name));

  return {
    url,
    name: typeof body.instance_name === "string" ? body.instance_name : "",
    version: typeof body.version === "string" ? body.version : "",
    categories: stringList(body.categories),
    engines,
  };
}

/**
 * How long a good read is reused. SearXNG's category and engine names come from
 * its own release, so they change with an upgrade, not with a page load.
 */
const INSTANCE_TTL_MS = 7 * 24 * 60 * 60_000;

/** How long a failed read is remembered, so an unreachable instance is retried at intervals. */
const INSTANCE_FAILURE_TTL_MS = 60_000;

let cachedInstance: { at: number; instance: SearchInstance | null } | null = null;
let inFlight: Promise<SearchInstance | null> | null = null;

/**
 * The instance's config for a caller that can live without it, such as a system
 * prompt. Null when the instance cannot be read, and the prompt keeps its
 * generic wording.
 */
export async function readSearchInstance(): Promise<SearchInstance | null> {
  const ttl = cachedInstance?.instance ? INSTANCE_TTL_MS : INSTANCE_FAILURE_TTL_MS;
  if (cachedInstance && Date.now() - cachedInstance.at < ttl) return cachedInstance.instance;
  if (inFlight) return inFlight;

  inFlight = fetchSearchInstance(2_000)
    .then((instance) => {
      cachedInstance = { at: Date.now(), instance };
      return instance;
    })
    .catch((err: unknown) => {
      console.error("Failed to read the search instance:", err);
      cachedInstance = { at: Date.now(), instance: null };
      return null;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}
