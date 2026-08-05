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
import { useState } from "react";
import type { ToolCallData } from "./types";

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
 * Get a favicon-like icon for a domain.
 */
function getFaviconUrl(url: string): string {
  try {
    const { hostname } = new URL(url);
    return `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`;
  } catch {
    return "";
  }
}

/**
 * Shorten a URL for display (remove protocol, truncate if long).
 */
function shortenUrl(url: string): string {
  try {
    const { hostname, pathname } = new URL(url);
    const display = hostname + (pathname.length > 30 ? pathname.slice(0, 27) + "…" : pathname);
    return display.length > 50 ? display.slice(0, 48) + "…" : display;
  } catch {
    return url.length > 50 ? url.slice(0, 48) + "…" : url;
  }
}

/**
 * Get domain from URL for display.
 */
function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace("www.", "");
  } catch {
    return url;
  }
}

/**
 * Card for a single search result.
 */
function SearchResultCard({ title, url, engine }: { title: string; url: string; engine: string }) {
  const favicon = getFaviconUrl(url);
  const domain = getDomain(url);

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex items-start gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-white/10"
    >
      {/* Favicon */}
      <div className="shrink-0 pt-0.5">
        {favicon ? (
          // eslint-disable-next-line @next/next/no-img-element -- external favicon from Google CDN
          <img
            src={favicon}
            alt=""
            className="h-4 w-4 rounded-sm object-contain"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        ) : (
          <Globe className="text-muted-foreground h-4 w-4" />
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <p className="text-foreground/90 group-hover:text-foreground truncate text-xs leading-snug font-medium">
          {title}
        </p>
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground/80 text-[11px]">{domain}</span>
          {engine && (
            <Badge variant="secondary" className="rounded px-1 py-0 text-[10px] font-normal">
              {engine}
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

  const maxVisible = 3;
  const visibleResults = meta.results.slice(0, expanded ? meta.results.length : maxVisible);
  const hasMore = meta.results.length > maxVisible;

  return (
    <div className="liquid-glass-inner rounded-xl">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2">
        <Search className="text-muted-foreground h-3 w-3" />
        <span className="text-xs font-medium">Searched</span>
        <span className="text-muted-foreground truncate text-xs">&ldquo;{meta.query}&rdquo;</span>
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
      {meta.results.length > 0 && (
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
  const favicon = getFaviconUrl(displayUrl);
  const domain = getDomain(displayUrl);
  const title = meta.title || shortenUrl(displayUrl);

  return (
    <div className="liquid-glass-inner rounded-xl">
      <div className="flex items-center gap-2 px-3 py-2">
        <Globe className="text-muted-foreground h-3 w-3" />
        <span className="text-xs font-medium">Fetched</span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {favicon && (
              // eslint-disable-next-line @next/next/no-img-element -- external favicon from Google CDN
              <img
                src={favicon}
                alt=""
                className="h-3.5 w-3.5 shrink-0 rounded-sm object-contain"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
            )}
            <span className="text-muted-foreground truncate text-xs">
              {meta.error ? domain : title}
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

      {meta.error && meta.errorMessage && (
        <div className="border-border/30 border-t px-3 py-2">
          <p className="text-xs text-red-600/80 dark:text-red-400/80">{meta.errorMessage}</p>
        </div>
      )}
    </div>
  );
}
