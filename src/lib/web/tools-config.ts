/**
 * What the web tools send, and the bounds the admin settings keep.
 *
 * Pure data, no Node or database imports: the admin page, the tool and the
 * stored columns all read the same numbers.
 *
 * An engine list is the sources a search may use. SearXNG unions the engines in
 * `engines` with the engines of `categories`, so a call that names engines sends
 * no category. Categories decide the search when it names no engine.
 */

/**
 * SearXNG's default result set. The two sets share only some engines, and a
 * scrape engine that suspends itself empties `general` long before `web`.
 */
export const DEFAULT_SEARCH_CATEGORIES: readonly string[] = ["general", "web"];

/** Results one call returns when the model asks for no number. */
export const DEFAULT_RESULTS_PER_CALL = 10;

/** The most one call may return, whatever the model asks for. */
export const MAX_RESULTS_PER_CALL = 50;

export const DEFAULT_MAX_CHARS = 50_000;
export const MIN_MAX_CHARS = 1_000;
export const MAX_MAX_CHARS = 500_000;

export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
export const MIN_FETCH_TIMEOUT_MS = 1_000;
export const MAX_FETCH_TIMEOUT_MS = 120_000;

export const DEFAULT_MAX_REDIRECTS = 5;
export const MAX_MAX_REDIRECTS = 20;

export interface WebSearchSettings {
  /** The only engines a search may use. Empty leaves the instance's own set. */
  engines: readonly string[];
  /** Categories a search without engines draws from. */
  categories: readonly string[];
  safeSearch: 0 | 1 | 2;
  /** SearXNG language code, `all` for every language. */
  language: string;
  resultsPerCall: number;
}

export interface WebFetchSettings {
  maxChars: number;
  timeoutMs: number;
  maxRedirects: number;
}

/** Holds a stored number inside the range the client sends. */
export function clampSetting(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), min), max);
}

/** A safe search level, whatever the stored number says. */
export function safeSearchLevel(value: number): 0 | 1 | 2 {
  if (value === 1) return 1;
  if (value === 2) return 2;
  return 0;
}

/** What the model asked `web_search` for. */
export interface SearchRequest {
  categories?: string | undefined;
  engines?: string | undefined;
  language?: string | undefined;
  safeSearch?: 0 | 1 | 2 | undefined;
  timeRange?: "day" | "month" | "year" | undefined;
  limit?: number | undefined;
}

/** What the search client sends. */
export interface SearchCall {
  categories?: string | undefined;
  engines?: string | undefined;
  language: string;
  safeSearch: 0 | 1 | 2;
  timeRange?: "day" | "month" | "year" | undefined;
  maxResults: number;
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * One search call: the admin's sources are the ceiling, the model picks within
 * them.
 *
 * With an engine list configured, a search runs on those engines and drops the
 * ones the model names outside the list. An engines call leaves the categories
 * out, because SearXNG would search both sets.
 */
export function resolveSearchCall(settings: WebSearchSettings, request: SearchRequest): SearchCall {
  const allowed = settings.engines;
  const requested = splitList(request.engines).filter(
    (name) => allowed.length === 0 || allowed.includes(name),
  );
  // With sources configured, a search runs on all of them unless the model
  // named some that are allowed.
  const engines = requested.length > 0 ? requested : [...allowed];

  const enginesParam = engines.length > 0 ? engines.join(",") : undefined;
  const categoriesParam =
    enginesParam !== undefined
      ? undefined
      : splitList(request.categories).join(",") || settings.categories.join(",");

  return {
    ...(categoriesParam !== undefined ? { categories: categoriesParam } : {}),
    ...(enginesParam !== undefined ? { engines: enginesParam } : {}),
    language: request.language?.trim() || settings.language,
    safeSearch: request.safeSearch ?? settings.safeSearch,
    ...(request.timeRange !== undefined ? { timeRange: request.timeRange } : {}),
    maxResults: Math.min(request.limit ?? settings.resultsPerCall, MAX_RESULTS_PER_CALL),
  };
}

/** The characters, timeout and redirects one fetch runs with. */
export function resolveFetchCall(
  settings: WebFetchSettings,
  request: { maxChars?: number | undefined; timeoutMs?: number | undefined },
): WebFetchSettings {
  return {
    maxChars: clampSetting(
      request.maxChars ?? settings.maxChars,
      MIN_MAX_CHARS,
      MAX_MAX_CHARS,
      DEFAULT_MAX_CHARS,
    ),
    timeoutMs: clampSetting(
      request.timeoutMs ?? settings.timeoutMs,
      MIN_FETCH_TIMEOUT_MS,
      MAX_FETCH_TIMEOUT_MS,
      DEFAULT_FETCH_TIMEOUT_MS,
    ),
    maxRedirects: settings.maxRedirects,
  };
}
