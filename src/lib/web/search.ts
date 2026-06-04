/**
 * SearXNG search client.
 * Queries a self-hosted SearXNG instance via its JSON API.
 */

const SEARXNG_URL = process.env.SEARXNG_URL ?? "http://saale-searxng:8080";

export interface SearchResult {
  title: string;
  url: string;
  content: string | undefined;
  engine: string[] | string;
  parsedUrl: string[] | undefined;
  score: number;
  iAmMath: boolean;
  imprint:
    | {
        content: string | undefined;
        url: string | undefined;
      }
    | undefined;
  template: string | undefined;
  publishedDate: string | undefined;
  thumbnail:
    | {
        src: string | undefined;
      }
    | undefined;
}

export interface SearXNGResponse {
  query: string;
  numberOfResults: string;
  results: SearchResult[];
  suggestions: string[] | undefined;
  unresponsiveEngines: string[] | undefined;
  answers: string[] | undefined;
  corrections: string[] | undefined;
}

export interface SearchOptions {
  /** Search query */
  query: string;
  /** Search categories (default: "general") */
  categories?: string | undefined;
  /** Specific engines to use (comma-separated) */
  engines?: string | undefined;
  /** Language code (default: "all") */
  language?: string | undefined;
  /** Page number (default: 1) */
  page?: number | undefined;
  /** Time range filter */
  timeRange?: "day" | "month" | "year" | undefined;
  /** Safe search level (0 = off, 1 = moderate, 2 = strict) */
  safeSearch?: 0 | 1 | 2 | undefined;
  /** Maximum number of results to return */
  maxResults?: number | undefined;
}

/**
 * Search the web via SearXNG's JSON API.
 */
export async function searchWeb(options: SearchOptions): Promise<SearXNGResponse> {
  const params = new URLSearchParams({
    q: options.query,
    format: "json",
    categories: options.categories ?? "general",
    language: options.language ?? "all",
    pageno: String(options.page ?? 1),
    safesearch: String(options.safeSearch ?? 0),
  });

  if (options.engines) {
    params.set("engines", options.engines);
  }
  if (options.timeRange) {
    params.set("time_range", options.timeRange);
  }

  const url = `${SEARXNG_URL}/search?${params.toString()}`;

  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`SearXNG search failed: HTTP ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as SearXNGResponse;

  // Trim results if maxResults is set
  if (options.maxResults && data.results.length > options.maxResults) {
    data.results = data.results.slice(0, options.maxResults);
  }

  return data;
}
