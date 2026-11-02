import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { defineStructuredTool } from "@/lib/pi/tools/tool-result";
import { searchWeb } from "@/lib/web/search";
import { fetchUrl } from "@/lib/web/fetch";
import { readWebTools } from "@/lib/web/tool-settings";
import { resolveFetchCall, resolveSearchCall } from "@/lib/web/tools-config";

/** A search hit as a script reads it, plus the snippet the text shows. */
const webSearchSchema = Type.Object({
  query: Type.String(),
  count: Type.Integer(),
  results: Type.Array(
    Type.Object({
      title: Type.String(),
      url: Type.String(),
      engine: Type.String(),
      content: Type.Optional(Type.String()),
    }),
  ),
});

/** A fetched page. or why it could not be fetched, which is a normal result. */
const webFetchSchema = Type.Object({
  url: Type.String(),
  error: Type.Boolean(),
  errorMessage: Type.Optional(Type.String()),
  finalUrl: Type.Optional(Type.String()),
  title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  siteName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  content: Type.Optional(Type.String()),
});

/**
 * Create web tools (search + fetch) for Pi agent sessions.
 * Returns an array of tool definitions for direct spread into the agent session.
 */
export function createWebTools(): ToolDefinition[] {
  return [
    // ─── web_search ──────────────────────────────────────────────

    defineStructuredTool({
      name: "web_search",
      label: "Web Search",
      description:
        "Search the web through the workspace's SearXNG instance. Returns titles, URLs and snippets.",
      parameters: Type.Object({
        query: Type.String({
          description: "Search query.",
        }),
        categories: Type.Optional(
          Type.String({
            description:
              "Category names, comma-separated. Leave out to use the instance's default categories.",
          }),
        ),
        engines: Type.Optional(
          Type.String({
            description:
              "Engine names, comma-separated. A name the operator does not allow is dropped.",
          }),
        ),
        language: Type.Optional(
          Type.String({
            description: "Language code. Leave out to use the instance's default language.",
          }),
        ),
        timeRange: Type.Optional(
          Type.Union([Type.Literal("day"), Type.Literal("month"), Type.Literal("year")]),
        ),
        safeSearch: Type.Optional(Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2)])),
        limit: Type.Optional(
          Type.Integer({
            description: "Maximum number of results. Falls back to the instance's own setting.",
          }),
        ),
      }),
      outputSchema: webSearchSchema,
      execute: async (_toolCallId, params) => {
        const { search } = await readWebTools();
        const call = resolveSearchCall(search, {
          categories: params.categories,
          engines: params.engines,
          language: params.language,
          safeSearch: params.safeSearch as 0 | 1 | 2 | undefined,
          timeRange: params.timeRange,
          limit: params.limit,
        });

        const result = await searchWeb({ query: params.query, page: 1, ...call });

        const formatted = result.results
          .map(
            (r, i) =>
              `${i + 1}. **[${r.title}](${r.url})**\n${Array.isArray(r.engine) ? r.engine.join(", ") : (r.engine ?? "")}${r.content ? `\n${r.content.slice(0, 300)}` : ""}`,
          )
          .join("\n\n");

        // Structured metadata for UI rendering (search result cards)
        const webMeta = {
          _saaleWebMeta: {
            type: "web_search" as const,
            query: params.query,
            count: result.results.length,
            results: result.results.map((r) => ({
              title: r.title,
              url: r.url,
              engine: Array.isArray(r.engine) ? r.engine.join(", ") : (r.engine ?? ""),
            })),
          },
        };

        return {
          value: {
            query: params.query,
            count: result.results.length,
            results: result.results.map((r) => ({
              title: r.title,
              url: r.url,
              engine: Array.isArray(r.engine) ? r.engine.join(", ") : (r.engine ?? ""),
              ...(r.content ? { content: r.content } : {}),
            })),
          },
          text: `Search results for "${params.query}" (${result.results.length} results):\n\n${formatted || "No results found."}\n\n${JSON.stringify(webMeta)}`,
          details: { count: result.results.length },
        };
      },
    }),

    // ─── web_fetch ───────────────────────────────────────────────

    defineStructuredTool({
      name: "web_fetch",
      label: "Fetch URL",
      description:
        "Fetch a URL with browser TLS fingerprinting and extract clean, readable content. Supports markdown, HTML, text, JSON, and raw output formats. Bypasses basic anti-bot detection via TLS/HTTP2 impersonation. Reddit URLs (posts, comment pages, subreddits, user profiles) are resolved via the Arctic Shift archive instead of Reddit directly. content is near-real-time, but scores are stale until ~36h after posting.",
      parameters: Type.Object({
        url: Type.String({
          description: "URL to fetch (http/https only).",
        }),
        browser: Type.Optional(
          Type.String({
            description:
              'Browser profile for TLS fingerprinting. Default: "chrome_145". Examples: chrome_145, firefox_147, safari_26, edge_145, opera_127.',
          }),
        ),
        os: Type.Optional(
          Type.String({
            description:
              'OS profile for fingerprinting. Default: "windows". Options: windows, macos, linux, android, ios.',
          }),
        ),
        headers: Type.Optional(
          Type.Record(Type.String(), Type.String(), {
            description:
              "Custom HTTP headers to send. By default, Accept and Accept-Language are set automatically.",
          }),
        ),
        maxChars: Type.Optional(
          Type.Integer({
            description: "Maximum characters to return. Falls back to the instance's own budget.",
          }),
        ),
        timeoutMs: Type.Optional(
          Type.Integer({
            description:
              "Request timeout in milliseconds. Falls back to the instance's own budget.",
          }),
        ),
        format: Type.Optional(
          Type.Union([
            Type.Literal("markdown"),
            Type.Literal("html"),
            Type.Literal("text"),
            Type.Literal("json"),
            Type.Literal("raw"),
          ]),
        ),
        removeImages: Type.Optional(
          Type.Boolean({
            description: "Strip image references from output. Default: false.",
          }),
        ),
      }),
      outputSchema: webFetchSchema,
      execute: async (_toolCallId, params) => {
        const { fetch } = await readWebTools();
        const result = await fetchUrl({
          url: params.url,
          ...(params.browser !== undefined ? { browser: params.browser } : {}),
          ...(params.os !== undefined ? { os: params.os } : {}),
          ...(params.headers !== undefined ? { headers: params.headers } : {}),
          ...(params.format !== undefined ? { format: params.format } : {}),
          ...(params.removeImages !== undefined ? { removeImages: params.removeImages } : {}),
          ...resolveFetchCall(fetch, { maxChars: params.maxChars, timeoutMs: params.timeoutMs }),
        });

        if ("error" in result) {
          const webMeta = {
            _saaleWebMeta: {
              type: "web_fetch" as const,
              url: params.url,
              title: null,
              siteName: null,
              error: true,
              errorMessage: result.error,
            },
          };
          return {
            value: {
              url: params.url,
              error: true,
              errorMessage: result.error,
            },
            text: `Error fetching ${params.url}: ${result.error}\n${JSON.stringify(webMeta)}`,
            details: { url: params.url, format: "text" as const, error: true, code: result.code },
          };
        }

        // Build metadata header
        const metadataLines: string[] = [];
        if (result.title) metadataLines.push(`Title: ${result.title}`);
        if (result.url !== result.finalUrl) metadataLines.push(`URL: ${result.finalUrl}`);
        if (result.author) metadataLines.push(`Author: ${result.author}`);
        if (result.description) metadataLines.push(`Description: ${result.description}`);
        if (result.siteName) metadataLines.push(`Site: ${result.siteName}`);
        if (result.publishedDate) metadataLines.push(`Published: ${result.publishedDate}`);

        const metadataHeader =
          metadataLines.length > 0 ? `> ${metadataLines.join("\n> ")}\n\n` : `> ${result.url}\n\n`;

        // Structured metadata for UI rendering (fetch card)
        const webMeta = {
          _saaleWebMeta: {
            type: "web_fetch" as const,
            url: result.url,
            finalUrl: result.finalUrl,
            title: result.title || null,
            siteName: result.siteName || null,
            error: false,
          },
        };

        return {
          value: {
            url: result.url,
            error: false,
            finalUrl: result.finalUrl,
            title: result.title || null,
            siteName: result.siteName || null,
            content: result.content,
          },
          text: metadataHeader + result.content + `\n${JSON.stringify(webMeta)}`,
          details: { url: result.url, format: result.format, error: false, code: "ok" },
        };
      },
    }),
  ];
}
