import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { searchWeb } from "@/lib/web/search";
import { fetchUrl } from "@/lib/web/fetch";

/**
 * Create web tools (search + fetch) for Pi agent sessions.
 */
export function createWebTools() {
  return {
    // ─── web_search ──────────────────────────────────────────────

    webSearchTool: defineTool({
      name: "web_search",
      label: "Web Search",
      description:
        "Search the web using SearXNG. Returns titles, URLs, and snippets from multiple search engines.",
      parameters: Type.Object({
        query: Type.String({
          description: "Search query.",
        }),
        categories: Type.Optional(
          Type.String({
            description:
              "Search categories (default: 'general'). Examples: 'general', 'images', 'news', 'videos', 'music', 'files', 'it', 'science', 'social media'.",
          }),
        ),
        engines: Type.Optional(
          Type.String({
            description:
              "Comma-separated list of engines to use. Examples: 'google,bing,duckduckgo'.",
          }),
        ),
        language: Type.Optional(
          Type.String({
            description: "Language code (default: 'all'). Examples: 'en', 'en-US', 'de'.",
          }),
        ),
        timeRange: Type.Optional(
          Type.Union([Type.Literal("day"), Type.Literal("month"), Type.Literal("year")]),
        ),
        safeSearch: Type.Optional(Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2)])),
        limit: Type.Optional(
          Type.Integer({
            description: "Maximum number of results. Default: 10.",
          }),
        ),
      }),
      execute: async (_toolCallId, params) => {
        const result = await searchWeb({
          query: params.query,
          ...(params.categories !== undefined ? { categories: params.categories } : {}),
          ...(params.engines !== undefined ? { engines: params.engines } : {}),
          ...(params.language !== undefined ? { language: params.language } : {}),
          page: 1,
          ...(params.timeRange !== undefined ? { timeRange: params.timeRange } : {}),
          ...(params.safeSearch !== undefined
            ? { safeSearch: params.safeSearch as 0 | 1 | 2 }
            : {}),
          maxResults: params.limit ?? 10,
        });

        const formatted = result.results
          .map(
            (r, i) =>
              `${i + 1}. **[${r.title}](${r.url})**\n${Array.isArray(r.engine) ? r.engine.join(", ") : (r.engine ?? "")}${r.content ? `\n${r.content.slice(0, 300)}` : ""}`,
          )
          .join("\n\n");

        return {
          content: [
            {
              type: "text",
              text: `Search results for "${params.query}" (${result.results.length} results):\n\n${formatted || "No results found."}`,
            },
          ],
          details: { count: result.results.length },
        };
      },
    }),

    // ─── web_fetch ───────────────────────────────────────────────

    webFetchTool: defineTool({
      name: "web_fetch",
      label: "Fetch URL",
      description:
        "Fetch a URL with browser TLS fingerprinting and extract clean, readable content. Supports markdown, HTML, text, JSON, and raw output formats. Bypasses basic anti-bot detection via TLS/HTTP2 impersonation.",
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
            description: "Maximum characters to return. Default: 50000.",
          }),
        ),
        timeoutMs: Type.Optional(
          Type.Integer({
            description: "Request timeout in milliseconds. Default: 15000.",
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
      execute: async (_toolCallId, params) => {
        const result = await fetchUrl({
          url: params.url,
          ...(params.browser !== undefined ? { browser: params.browser } : {}),
          ...(params.os !== undefined ? { os: params.os } : {}),
          ...(params.headers !== undefined ? { headers: params.headers } : {}),
          ...(params.maxChars !== undefined ? { maxChars: params.maxChars } : {}),
          ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
          ...(params.format !== undefined ? { format: params.format } : {}),
          ...(params.removeImages !== undefined ? { removeImages: params.removeImages } : {}),
        });

        if ("error" in result) {
          return {
            content: [
              {
                type: "text",
                text: `Error fetching ${params.url}: ${result.error}`,
              },
            ],
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

        return {
          content: [
            {
              type: "text",
              text: metadataHeader + result.content,
            },
          ],
          details: { url: result.url, format: result.format, error: false, code: "ok" },
        };
      },
    }),
  };
}
