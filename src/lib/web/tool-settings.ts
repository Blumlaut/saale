/**
 * The web tools' settings, read from the admin settings row.
 *
 * Read per call, so a saved change takes effect on the next search or fetch.
 */

import { prisma } from "@/lib/db";
import {
  clampSetting,
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_RESULTS_PER_CALL,
  DEFAULT_SEARCH_CATEGORIES,
  MAX_FETCH_TIMEOUT_MS,
  MAX_MAX_CHARS,
  MAX_MAX_REDIRECTS,
  MAX_RESULTS_PER_CALL,
  MIN_FETCH_TIMEOUT_MS,
  MIN_MAX_CHARS,
  safeSearchLevel,
  type WebFetchSettings,
  type WebSearchSettings,
} from "@/lib/web/tools-config";

export interface WebToolsSettings {
  search: WebSearchSettings;
  fetch: WebFetchSettings;
}

/** What this instance allows the web tools to do. */
export async function readWebTools(): Promise<WebToolsSettings> {
  const row = await prisma.adminSettings.findUnique({
    where: { id: "global" },
    select: {
      webSearchEngines: true,
      webSearchCategories: true,
      webSearchSafeSearch: true,
      webSearchLanguage: true,
      webSearchResultsPerCall: true,
      webFetchMaxChars: true,
      webFetchTimeoutMs: true,
      webFetchMaxRedirects: true,
    },
  });

  return {
    search: {
      engines: row?.webSearchEngines ?? [],
      categories:
        row?.webSearchCategories && row.webSearchCategories.length > 0
          ? row.webSearchCategories
          : [...DEFAULT_SEARCH_CATEGORIES],
      safeSearch: safeSearchLevel(row?.webSearchSafeSearch ?? 0),
      language: row?.webSearchLanguage?.trim() || "all",
      resultsPerCall: clampSetting(
        row?.webSearchResultsPerCall ?? DEFAULT_RESULTS_PER_CALL,
        1,
        MAX_RESULTS_PER_CALL,
        DEFAULT_RESULTS_PER_CALL,
      ),
    },
    fetch: {
      maxChars: clampSetting(
        row?.webFetchMaxChars ?? DEFAULT_MAX_CHARS,
        MIN_MAX_CHARS,
        MAX_MAX_CHARS,
        DEFAULT_MAX_CHARS,
      ),
      timeoutMs: clampSetting(
        row?.webFetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
        MIN_FETCH_TIMEOUT_MS,
        MAX_FETCH_TIMEOUT_MS,
        DEFAULT_FETCH_TIMEOUT_MS,
      ),
      maxRedirects: clampSetting(
        row?.webFetchMaxRedirects ?? DEFAULT_MAX_REDIRECTS,
        0,
        MAX_MAX_REDIRECTS,
        DEFAULT_MAX_REDIRECTS,
      ),
    },
  };
}
