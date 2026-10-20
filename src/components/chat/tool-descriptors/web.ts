import { Globe, Search } from "lucide-react";
import { plural, truncate } from "@/lib/format";
import { extractToolMeta } from "@/lib/chat/tool-meta";
import { toolStatus } from "../tool-status";
import type { ToolCardModel, ToolDescriptor, ToolRowModel } from "../tool-card-model";
import type { ToolCallData } from "../types";

/** Max characters before truncation. */
const MAX_TITLE = 100;
const MAX_DOMAIN = 40;
const MAX_QUERY = 60;
const MAX_ENGINE = 16;
const MAX_ERROR = 200;
const MAX_URL = 50;
/**
 * A domain is also a badge label, where it shares the row with the card's
 * title. so it is capped harder there than in the detail.
 */
const MAX_BADGE_DOMAIN = 24;

/** Favicons come from Google's public favicon service. */
const FAVICON_SERVICE = "https://www.google.com/s2/favicons";

/**
 * Structured metadata embedded in web_search / web_fetch results.
 * Extracted from the `_saaleWebMeta` block appended by the tools.
 */
interface WebSearchMeta {
  type: "web_search";
  query: string;
  count: number;
  results: Array<{ title: string; url: string; engine: string }>;
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

/** Cards for the tools that reach the web. */
export const webToolDescriptor: ToolDescriptor = {
  names: ["web_search", "web_fetch"],
  describe(toolCall): ToolCardModel | null {
    const meta = extractToolMeta<WebMeta>(toolCall.result);
    if (meta?.type === "web_search") return searchModel(toolCall, meta);
    if (meta?.type === "web_fetch") return fetchModel(toolCall, meta);
    return null;
  },
};

function searchModel(toolCall: ToolCallData, meta: WebSearchMeta): ToolCardModel {
  const query = sanitize(meta.query, MAX_QUERY);

  return {
    icon: Search,
    title: "Searched",
    ...(query ? { detail: `“${query}”` } : {}),
    status: toolStatus(toolCall, plural(meta.count, "result", "results")),
    defaultOpen: true,
    blocks: [
      {
        kind: "rows",
        items: (meta.results ?? []).map(searchRow),
        empty: "No results found",
      },
    ],
  };
}

function searchRow(result: WebSearchMeta["results"][number]): ToolRowModel {
  const engine = sanitize(result.engine, MAX_ENGINE);

  return {
    leading: { kind: "favicon", url: faviconUrl(result.url) },
    title: sanitize(result.title, MAX_TITLE) || shortenUrl(result.url),
    meta: [
      { kind: "text", text: domain(result.url) },
      ...(engine ? [{ kind: "badge" as const, text: engine }] : []),
    ],
    href: result.url,
  };
}

function fetchModel(toolCall: ToolCallData, meta: WebFetchMeta): ToolCardModel {
  const url = meta.finalUrl || meta.url;
  const title = sanitize(meta.title ?? "", MAX_TITLE);
  const error = sanitize(meta.errorMessage ?? "", MAX_ERROR);
  const site = domain(url);
  const detail = title || (meta.error ? site : "");
  const badgeSite = truncate(site, MAX_BADGE_DOMAIN);

  return {
    icon: Globe,
    title: "Fetched",
    ...(detail ? { detail } : {}),
    status: meta.error ? toolStatus(toolCall, "error", "danger") : toolStatus(toolCall, badgeSite),
    ...(meta.error ? { defaultOpen: true } : {}),
    ...(meta.error ? {} : { action: { href: url, label: `Open ${site}` } }),
    blocks: error ? [{ kind: "text", text: error, tone: "danger" }] : [],
  };
}

/** Trim, collapse whitespace and truncate. for any value shown in the card. */
function sanitize(value: string, max: number): string {
  return truncate(value.trim().replace(/\s+/g, " "), max);
}

/**
 * The favicon of the page a `web_fetch` call opened, or null when there is no
 * URL to resolve yet.
 *
 * Read from the result's metadata first and the call's argument second, so a
 * call still running already shows the site it is reaching for.
 */
export function webFetchFaviconUrl(toolCall: ToolCallData): string | null {
  const meta = extractToolMeta<WebMeta>(toolCall.result);
  const fromResult = meta?.type === "web_fetch" ? meta.finalUrl || meta.url : "";
  const fromArgs = typeof toolCall.args.url === "string" ? toolCall.args.url : "";
  const pageUrl = fromResult || fromArgs;
  return pageUrl ? faviconUrl(pageUrl) || null : null;
}

/** The clickable favicon for a site, or "" when the URL cannot be parsed. */
function faviconUrl(pageUrl: string): string {
  const parsed = parse(pageUrl);
  return parsed ? `${FAVICON_SERVICE}?domain=${parsed.hostname}&sz=32` : "";
}

/** A site's domain, without the "www.". */
function domain(pageUrl: string): string {
  const parsed = parse(pageUrl);
  return parsed
    ? truncate(parsed.hostname.replace("www.", ""), MAX_DOMAIN)
    : truncate(pageUrl, MAX_DOMAIN);
}

/** Hostname and path, shortened for display. */
function shortenUrl(pageUrl: string): string {
  const parsed = parse(pageUrl);
  if (!parsed) return truncate(pageUrl, MAX_URL);
  const path = parsed.pathname.length > 25 ? parsed.pathname.slice(0, 23) + "…" : parsed.pathname;
  return truncate(parsed.hostname + path, MAX_URL);
}

function parse(pageUrl: string): URL | null {
  try {
    return new URL(pageUrl);
  } catch {
    return null;
  }
}
