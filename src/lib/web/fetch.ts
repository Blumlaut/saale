/**
 * Web page fetcher with browser TLS fingerprinting and content extraction.
 *
 * Uses wreq-js for browser-grade TLS/HTTP2 impersonation and defuddle for
 * clean article/content extraction. Inspired by pi-smart-fetch (MIT licensed).
 *
 * Unlike pi-smart-fetch this is a plain library module — no Pi TUI or
 * extension API dependencies.
 */

import { fetch as wreqFetch } from "wreq-js";
import { Defuddle } from "defuddle/node";

// ─── Defaults ──────────────────────────────────────────────────

const DEFAULT_BROWSER = "chrome_145";
const DEFAULT_OS = "windows";
const DEFAULT_MAX_CHARS = 50_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_ACCEPT_LANGUAGE = "en-US,en;q=0.9";
const MAX_REDIRECTS = 5;

// ─── Types ─────────────────────────────────────────────────────

export type FetchFormat = "markdown" | "html" | "text" | "json" | "raw";

export interface FetchOptions {
  /** URL to fetch (http/https only) */
  url: string;
  /** Browser profile for TLS fingerprinting */
  browser?: string | undefined;
  /** OS profile for fingerprinting */
  os?: string | undefined;
  /** Custom HTTP headers */
  headers?: Record<string, string> | undefined;
  /** Maximum characters to return */
  maxChars?: number | undefined;
  /** Request timeout in milliseconds */
  timeoutMs?: number | undefined;
  /** Output format */
  format?: FetchFormat | undefined;
  /** Strip image references from output */
  removeImages?: boolean | undefined;
  /** Include replies/comments */
  includeReplies?: boolean | "extractors" | undefined;
  /** Proxy URL */
  proxy?: string | undefined;
}

export interface FetchResult {
  /** Original URL requested */
  url: string;
  /** Final URL after redirects */
  finalUrl: string;
  /** HTTP status code */
  statusCode: number;
  /** MIME type */
  mimeType: string | undefined;
  /** Content length */
  contentLength: number | undefined;
  /** Title extracted from the page */
  title: string | undefined;
  /** Author extracted from the page */
  author: string | undefined;
  /** Description / excerpt */
  description: string | undefined;
  /** Site name */
  siteName: string | undefined;
  /** Published date */
  publishedDate: string | undefined;
  /** Extracted content in the requested format */
  content: string;
  /** Output format */
  format: FetchFormat;
}

export interface FetchError {
  /** Error message */
  error: string;
  /** Error code for programmatic handling */
  code: string;
  /** Phase where the error occurred */
  phase: string;
  /** Whether the request might succeed on retry */
  retryable: boolean;
  /** Original URL */
  url: string;
  /** Final URL (if redirects occurred) */
  finalUrl: string | undefined;
  /** HTTP status code (if available) */
  statusCode: number | undefined;
}

export type FetchOutput = FetchResult | FetchError;

// ─── Helpers ───────────────────────────────────────────────────

function resolveAcceptHeader(format: FetchFormat): string {
  switch (format) {
    case "html":
      return "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
    case "json":
      return "application/json,*/*;q=0.8";
    default:
      return "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
  }
}

function normalizeContentType(raw: string): string | undefined {
  if (!raw) return undefined;
  const match = raw.match(/^([^;]+)/);
  return match && match[1] ? match[1].trim().toLowerCase() : undefined;
}

function isTextualContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return (
    normalized.startsWith("text/") ||
    normalized.includes("html") ||
    normalized.includes("xml") ||
    normalized.includes("json") ||
    normalized.includes("javascript") ||
    normalized.includes("markdown")
  );
}

function isJsonResponse(contentType: string, body: string): boolean {
  const normalized = contentType.toLowerCase();
  if (normalized.includes("application/json")) return true;
  if (normalized.includes("text/json")) return true;
  try {
    JSON.parse(body.slice(0, 8192));
    return true;
  } catch {
    return false;
  }
}

function extractClientSideRedirect(html: string, baseUrl: string): string | null {
  const metaRefresh = html.match(
    /<meta\s+http-equiv=["']?refresh["']?\s+content=["']?\d+;\s*url=(.*?)["']?/i,
  );
  if (metaRefresh && metaRefresh[1]) {
    const url = metaRefresh[1].trim();
    try {
      return new URL(url, baseUrl).href;
    } catch {
      return null;
    }
  }

  const jsRedirect = html.match(/window\.location(?:\.href)?\s*=\s*["'](.*?)["']/i);
  if (jsRedirect && jsRedirect[1]) {
    const url = jsRedirect[1].trim();
    try {
      return new URL(url, baseUrl).href;
    } catch {
      return null;
    }
  }

  return null;
}

function truncateContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + "\n\n... [truncated]";
}

// ─── Core fetch logic ──────────────────────────────────────────

/**
 * Fetch a URL with browser TLS fingerprinting and extract clean content.
 */
export async function fetchUrl(options: FetchOptions): Promise<FetchOutput> {
  const browser = options.browser ?? DEFAULT_BROWSER;
  const os = options.os ?? DEFAULT_OS;
  const format = options.format ?? "markdown";
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const removeImages = options.removeImages ?? false;
  const includeReplies =
    options.includeReplies ?? (options.includeReplies === false ? false : "extractors");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Validate URL
  let parsed: URL;
  try {
    parsed = new URL(options.url);
  } catch {
    return {
      error: `Invalid URL: ${options.url}`,
      code: "invalid_url",
      phase: "validation",
      retryable: false,
      url: options.url,
      finalUrl: undefined,
      statusCode: undefined,
    };
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return {
      error: `Only http/https URLs supported, got ${parsed.protocol}`,
      code: "unsupported_protocol",
      phase: "validation",
      retryable: false,
      url: options.url,
      finalUrl: undefined,
      statusCode: undefined,
    };
  }

  return fetchWithRedirects(
    {
      url: parsed.href,
      browser,
      os,
      format,
      maxChars,
      removeImages,
      includeReplies,
      timeoutMs,
      headers: options.headers,
      proxy: options.proxy,
    },
    0,
  );
}

interface ResolvedFetchOptions {
  url: string;
  browser: string;
  os: string;
  format: FetchFormat;
  maxChars: number;
  removeImages: boolean;
  includeReplies: boolean | "extractors";
  timeoutMs: number;
  headers?: Record<string, string> | undefined;
  proxy?: string | undefined;
}

async function fetchWithRedirects(
  opts: ResolvedFetchOptions,
  redirectCount: number,
): Promise<FetchOutput> {
  const {
    url,
    browser,
    os,
    format,
    maxChars,
    removeImages,
    includeReplies,
    timeoutMs,
    headers,
    proxy,
  } = opts;

  const wreqHeaders: Record<string, string> = {
    Accept: resolveAcceptHeader(format),
    "Accept-Language": DEFAULT_ACCEPT_LANGUAGE,
    ...(headers ?? {}),
  };

  const wreqOptions: Record<string, unknown> = {
    browser,
    os,
    headers: wreqHeaders,
    redirect: "follow" as const,
    timeout: timeoutMs,
  };

  if (proxy) {
    wreqOptions.proxy = proxy;
  }

  // wreq-js response (not standard web Response)
  let wreqResponse: Awaited<ReturnType<typeof wreqFetch>>;
  try {
    wreqResponse = await wreqFetch(url, wreqOptions as Parameters<typeof wreqFetch>[1]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      error: `Network error fetching ${url}: ${message}`,
      code: "network_error",
      phase: "connecting",
      retryable: true,
      url,
      finalUrl: undefined,
      statusCode: undefined,
    };
  }

  const finalUrl = wreqResponse.url ?? url;
  const contentType = wreqResponse.headers.get("content-type") ?? "";
  const statusCode = wreqResponse.status;

  if (!wreqResponse.ok) {
    return {
      error: `Server returned HTTP ${statusCode} ${wreqResponse.statusText} for ${url}.`,
      code: "http_error",
      phase: "loading",
      retryable: statusCode >= 500 || statusCode === 429,
      url,
      finalUrl,
      statusCode,
    };
  }

  const rawBody = await wreqResponse.text();

  // Handle client-side redirects
  const clientRedirect = extractClientSideRedirect(rawBody, finalUrl);
  if (clientRedirect) {
    if (redirectCount >= MAX_REDIRECTS) {
      return {
        error: `Redirect limit (${MAX_REDIRECTS}) exceeded for ${url}.`,
        code: "too_many_redirects",
        phase: "loading",
        retryable: false,
        url,
        finalUrl,
        statusCode: undefined,
      };
    }
    return fetchWithRedirects({ ...opts, url: clientRedirect }, redirectCount + 1);
  }

  // Handle raw format
  if (format === "raw") {
    return {
      url,
      finalUrl,
      statusCode,
      mimeType: normalizeContentType(contentType),
      contentLength: rawBody.length,
      title: undefined,
      author: undefined,
      description: undefined,
      siteName: undefined,
      publishedDate: undefined,
      content: truncateContent(rawBody, maxChars),
      format: "raw",
    };
  }

  // Handle JSON responses
  const jsonResponse = isJsonResponse(contentType, rawBody);
  if (jsonResponse) {
    try {
      const parsed = JSON.parse(rawBody);
      const pretty = JSON.stringify(parsed, null, 2);
      return {
        url,
        finalUrl,
        statusCode,
        mimeType: normalizeContentType(contentType),
        contentLength: rawBody.length,
        title: undefined,
        author: undefined,
        description: undefined,
        siteName: undefined,
        publishedDate: undefined,
        content: truncateContent(pretty, maxChars),
        format: format === "json" ? "json" : "markdown",
      };
    } catch {
      // Fall through to HTML extraction
    }
  }

  // Extract content using defuddle
  if (
    isTextualContentType(contentType) ||
    contentType === "" ||
    format === "markdown" ||
    format === "text" ||
    format === "html"
  ) {
    try {
      const extracted = await Defuddle(rawBody, finalUrl, {
        markdown: format === "markdown",
        removeImages,
        includeReplies,
        useAsync: false,
      });

      const content =
        format === "markdown"
          ? (extracted.contentMarkdown ?? extracted.content ?? "")
          : (extracted.content ?? "");

      return {
        url,
        finalUrl,
        statusCode,
        mimeType: normalizeContentType(contentType),
        contentLength: rawBody.length,
        title: extracted.title || undefined,
        author: extracted.author || undefined,
        description: extracted.description || undefined,
        siteName: extracted.site || undefined,
        publishedDate: extracted.published || undefined,
        content: truncateContent(content, maxChars),
        format,
      };
    } catch {
      // Fallback: return raw body as text
      return {
        url,
        finalUrl,
        statusCode,
        mimeType: normalizeContentType(contentType),
        contentLength: rawBody.length,
        title: undefined,
        author: undefined,
        description: undefined,
        siteName: undefined,
        publishedDate: undefined,
        content: truncateContent(rawBody, maxChars),
        format: "text",
      };
    }
  }

  // Fallback for unknown content types
  return {
    url,
    finalUrl,
    statusCode,
    mimeType: normalizeContentType(contentType),
    contentLength: rawBody.length,
    title: undefined,
    author: undefined,
    description: undefined,
    siteName: undefined,
    publishedDate: undefined,
    content: truncateContent(rawBody, maxChars),
    format: "text",
  };
}
