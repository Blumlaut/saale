"use client";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ExternalLink,
  Globe,
  Search,
  AlertCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { useState, useMemo } from "react";
import type { ToolCallData } from "./types";

/** Max characters before truncation. */
const MAX_TITLE = 100;
const MAX_DOMAIN = 40;
const MAX_QUERY = 60;
const MAX_ENGINE = 16;
const MAX_ERROR = 200;
const MAX_URL_DISPLAY = 50;

/**
 * Structured metadata embedded in web_search / web_fetch tool results.
 * Extracted from the `_saaleWebMeta` JSON block appended by the tools.
 */
interface WebSearchMeta {
  type: "web_search";
  query: string;
  count: number;
  results: Array<{
    title: string;
    url: string;
    engine: string;
  }>;
}

interface WebFetchMeta {
  type: "web_fetch";
  url: string;
  finalUrl?: string;
  title: string | null;
  siteName: string | null;
  error: boolean;
  errorMessage?: string;
}

type WebMeta = WebSearchMeta | WebFetchMeta;

/**
 * Extract the _saaleWebMeta JSON block from a tool result string.
 * Looks for the last JSON object containing _saaleWebMeta.
 */
function extractWebMeta(result: string | undefined): WebMeta | null {
  if (!result) return null;

  const idx = result.lastIndexOf("{_saaleWebMeta");
  if (idx === -1) {
    // Try with whitespace after {
    const looseIdx = result.lastIndexOf('"_saaleWebMeta"');
    if (looseIdx === -1) return null;

    // Find the opening { before this key
    const openBrace = result.lastIndexOf("{", looseIdx);
    if (openBrace === -1) return null;

    // Find the closing }
    let depth = 0;
    let closeBrace = -1;
    for (let i = openBrace; i < result.length; i++) {
      if (result[i] === "{") depth++;
      else if (result[i] === "}") {
        depth--;
        if (depth === 0) {
          closeBrace = i;
          break;
        }
      }
    }
    if (closeBrace === -1) return null;

    try {
      return JSON.parse(result.slice(openBrace, closeBrace + 1))._saaleWebMeta as WebMeta;
    } catch {
      return null;
    }
  }

  // Find the closing }
  let depth = 0;
  let closeBrace = -1;
  for (let i = idx; i < result.length; i++) {
    if (result[i] === "{") depth++;
    else if (result[i] === "}") {
      depth--;
      if (depth === 0) {
        closeBrace = i;
        break;
      }
    }
  }
  if (closeBrace === -1) return null;

  try {
    return JSON.parse(result.slice(idx, closeBrace + 1))._saaleWebMeta as WebMeta;
  } catch {
    return null;
  }
}

/**
 * Truncate a string with ellipsis if it exceeds max length.
 * Preserves leading content and cuts from the end.
 */
function truncate(str: string, max: number): string {
  if (!str) return "";
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

/**
 * Parse a URL safely, returning null on failure.
 */
function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Get a favicon URL for a given URL.
 * Returns empty string if the URL is invalid.
 */
function getFaviconUrl(url: string): string {
  const parsed = parseUrl(url);
  if (!parsed) return "";
  return `https://www.google.com/s2/favicons?domain=${parsed.hostname}&sz=32`;
}

/**
 * Get domain from URL for display (strip www., truncate).
 */
function getDomain(url: string): string {
  const parsed = parseUrl(url);
  if (!parsed) return truncate(url, MAX_DOMAIN);
  const domain = parsed.hostname.replace("www.", "");
  return truncate(domain, MAX_DOMAIN);
}

/**
 * Shorten a URL for display (hostname + path, truncated).
 */
function shortenUrl(url: string): string {
  const parsed = parseUrl(url);
  if (!parsed) return truncate(url, MAX_URL_DISPLAY);
  const pathname =
    parsed.pathname.length > 25 ? parsed.pathname.slice(0, 23) + "…" : parsed.pathname;
  const display = parsed.hostname + pathname;
  return truncate(display, MAX_URL_DISPLAY);
}

/**
 * Sanitize a title — trim whitespace, collapse internal spaces, truncate.
 */
function sanitizeTitle(title: string): string {
  if (!title) return "";
  return truncate(title.trim().replace(/\s+/g, " "), MAX_TITLE);
}

/**
 * Sanitize an engine name — trim, truncate.
 */
function sanitizeEngine(engine: string): string {
  if (!engine) return "";
  return truncate(engine.trim(), MAX_ENGINE);
}

/**
 * Sanitize a query string — trim, truncate.
 */
function sanitizeQuery(query: string): string {
  if (!query) return "";
  return truncate(query.trim(), MAX_QUERY);
}

/**
 * Sanitize an error message — trim, truncate.
 */
function sanitizeError(error: string): string {
  if (!error) return "";
  return truncate(error.trim(), MAX_ERROR);
}

/**
 * Favicon with fallback to globe icon on load failure.
 */
function FaviconIcon({ url, className }: { url: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const faviconUrl = useMemo(() => getFaviconUrl(url), [url]);

  if (!faviconUrl || failed) {
    return <Globe className={cn("text-muted-foreground h-4 w-4", className)} />;
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- external favicon from Google CDN
    <img
      src={faviconUrl}
      alt=""
      className={cn("h-4 w-4 rounded-sm object-contain", className)}
      onError={() => setFailed(true)}
    />
  );
}

/**
 * Card for a single search result.
 */
function SearchResultCard({ title, url, engine }: { title: string; url: string; engine: string }) {
  const displayTitle = sanitizeTitle(title);
  const domain = getDomain(url);
  const displayEngine = sanitizeEngine(engine);

  // Skip rendering if both title and URL are empty/invalid
  if (!displayTitle && !url) return null;

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex items-start gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-white/10"
    >
      {/* Favicon */}
      <div className="shrink-0 pt-0.5">
        <FaviconIcon url={url} />
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <p className="text-foreground/90 group-hover:text-foreground line-clamp-2 text-xs leading-snug font-medium">
          {displayTitle || shortenUrl(url)}
        </p>
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground/80 text-[11px]">{domain}</span>
          {displayEngine && (
            <Badge variant="secondary" className="rounded px-1 py-0 text-[10px] font-normal">
              {displayEngine}
            </Badge>
          )}
        </div>
      </div>

      <ExternalLink className="text-muted-foreground/50 h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
    </a>
  );
}

/**
 * Web Search tool call card — shows search query and result cards.
 */
export function WebSearchCard({ toolCall }: { toolCall: ToolCallData }) {
  const meta = extractWebMeta(toolCall.result);
  const [expanded, setExpanded] = useState(false);

  if (!meta || meta.type !== "web_search") {
    return null;
  }

  const displayQuery = sanitizeQuery(meta.query);
  const results = meta.results ?? [];
  const maxVisible = 3;
  const visibleResults = results.slice(0, expanded ? results.length : maxVisible);
  const hasMore = results.length > maxVisible;

  return (
    <div className="liquid-glass-inner rounded-xl">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2">
        <Search className="text-muted-foreground h-3 w-3" />
        <span className="text-xs font-medium">Searched</span>
        {displayQuery && (
          <span className="text-muted-foreground truncate text-xs">
            &ldquo;{displayQuery}&rdquo;
          </span>
        )}
        <Badge
          variant="secondary"
          className={cn(
            "ml-auto rounded-full px-1.5 py-0 text-[10px]",
            toolCall.status === "running" && "bg-yellow-500/10 text-yellow-600",
            toolCall.status === "completed" && "bg-green-500/10 text-green-600",
            (toolCall.status === "error" || toolCall.error) && "bg-red-500/10 text-red-600",
          )}
        >
          {toolCall.status === "running" && <Loader2 className="mr-1 h-2.5 w-2.5 animate-spin" />}
          {toolCall.status === "completed" && <Globe className="mr-1 h-2.5 w-2.5" />}
          {(toolCall.status === "error" || toolCall.error) && (
            <AlertCircle className="mr-1 h-2.5 w-2.5" />
          )}
          {meta.count} results
        </Badge>
      </div>

      {/* Result cards */}
      {results.length > 0 ? (
        <div className="border-border/30 border-t px-1.5 py-1">
          <div className="space-y-0.5">
            {visibleResults.map((r, i) => (
              <SearchResultCard key={i} title={r.title} url={r.url} engine={r.engine} />
            ))}
          </div>

          {hasMore && !expanded && (
            <button
              onClick={() => setExpanded(true)}
              className="text-muted-foreground hover:text-foreground flex w-full items-center justify-center gap-1 pt-1.5 text-xs"
            >
              <ChevronDown className="h-3 w-3" />
              Show {meta.results.length - maxVisible} more
            </button>
          )}

          {hasMore && expanded && (
            <button
              onClick={() => setExpanded(false)}
              className="text-muted-foreground hover:text-foreground flex w-full items-center justify-center gap-1 pt-1.5 text-xs"
            >
              <ChevronRight className="h-3 w-3" />
              Show less
            </button>
          )}
        </div>
      ) : (
        <div className="border-border/30 border-t px-3 py-2.5">
          <p className="text-muted-foreground text-xs">No results found</p>
        </div>
      )}
    </div>
  );
}

/**
 * Web Fetch tool call card — shows the fetched URL and title.
 */
export function WebFetchCard({ toolCall }: { toolCall: ToolCallData }) {
  const meta = extractWebMeta(toolCall.result);

  if (!meta || meta.type !== "web_fetch") {
    return null;
  }

  const displayUrl = meta.finalUrl || meta.url;
  const domain = getDomain(displayUrl);
  const displayTitle = sanitizeTitle(meta.title || "");
  const fallbackTitle = displayTitle || shortenUrl(displayUrl);
  const displayError = sanitizeError(meta.errorMessage || "");

  return (
    <div className="liquid-glass-inner rounded-xl">
      <div className="flex items-center gap-2 px-3 py-2">
        <Globe className="text-muted-foreground h-3 w-3" />
        <span className="text-xs font-medium">Fetched</span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <FaviconIcon url={displayUrl} className="h-3.5 w-3.5" />
            <span className="text-muted-foreground truncate text-xs">
              {meta.error ? domain : fallbackTitle}
            </span>
          </div>
        </div>

        <Badge
          variant="secondary"
          className={cn(
            "ml-auto shrink-0 rounded-full px-1.5 py-0 text-[10px]",
            meta.error
              ? "bg-red-500/10 text-red-600"
              : toolCall.status === "running"
                ? "bg-yellow-500/10 text-yellow-600"
                : "bg-green-500/10 text-green-600",
          )}
        >
          {meta.error ? (
            <>
              <AlertCircle className="mr-1 h-2.5 w-2.5" />
              error
            </>
          ) : toolCall.status === "running" ? (
            <Loader2 className="mr-1 h-2.5 w-2.5 animate-spin" />
          ) : (
            <>
              <Globe className="mr-1 h-2.5 w-2.5" />
              {domain}
            </>
          )}
        </Badge>

        {!meta.error && (
          <Button variant="ghost" size="icon" className="h-5 w-5 shrink-0" asChild>
            <a
              href={displayUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          </Button>
        )}
      </div>

      {displayError && (
        <div className="border-border/30 border-t px-3 py-2">
          <p className="text-xs text-red-600/80 dark:text-red-400/80">{displayError}</p>
        </div>
      )}
    </div>
  );
}
