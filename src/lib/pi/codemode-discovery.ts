/**
 * The discovery helpers a script gets when Saale builds its own sandbox.
 *
 * A chat's scripts run under Pi's `codemode` extension, which registers
 * `searchTools()`, `describeTool()` and `describeNamespace()` itself. A watcher
 * runs in Saale's own sandbox (`watchers/runner.ts`), with no agent loop behind
 * it, so the same three helpers have to be provided here — a script written in a
 * conversation and moved to a watcher must see one surface, not two.
 *
 * Pi exports neither its ranker nor its search document, so the ranking below is
 * a port of its `extensions/tool-search/tool.js` (BM25, with the same tokenizer,
 * stop words and stemming), and a tool's text comes from Pi's own
 * `renderToolSample()` — the same text a chat's `ALL_TOOLS` shows for it. Both
 * sandboxes therefore answer one query with the same list, in the same order;
 * keep them in step, because a query that ranks a tool first in a chat has to
 * rank it first here too.
 */

import {
  renderToolSample,
  toCodemodeIdentifier,
  type CodemodeJsonSchema,
  type CodemodeTool,
} from "@earendil-works/pi-codemode";

/** A tool the discovery helpers can find. A `ToolDefinition` satisfies this. */
export interface DiscoverableTool {
  name: string;
  description: string;
  /** The tool's parameter schema, searched for property names and descriptions. */
  parameters: unknown;
  outputSchema?: unknown;
  namespace?: {
    name: string;
    description?: string;
    instructions?: string;
  };
}

/** How many matches `searchTools()` returns when the script does not say. Pi's default. */
export const DEFAULT_TOOL_SEARCH_LIMIT = 8;

/** What Pi's codemode says a tool resolves to when it declares no output schema. */
const TEXT_OUTPUT_SCHEMA: CodemodeJsonSchema = { type: "string" };

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with",
]);

/** Naive singular form, so `issues` matches `issue` and `searches` matches `search`. */
function stem(term: string): string {
  if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
  if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
  return term;
}

/** Lowercase terms, split at camelCase boundaries and non-alphanumerics, without stop words. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 0 && !STOP_WORDS.has(term))
    .map(stem);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Schema descriptions and property names, recursively. */
function schemaText(schema: unknown, parts: string[]): void {
  if (!isRecord(schema)) return;
  if (typeof schema.description === "string") parts.push(schema.description);
  if (isRecord(schema.properties)) {
    for (const [name, property] of Object.entries(schema.properties)) {
      parts.push(name);
      schemaText(property, parts);
    }
  }
  schemaText(schema.items, parts);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const variants = schema[key];
    if (Array.isArray(variants)) for (const variant of variants) schemaText(variant, parts);
  }
}

/**
 * The text a tool is ranked on: its name (as written and with `_` as spaces),
 * its description, and the descriptions and property names of its parameters.
 */
function toolSearchText(tool: DiscoverableTool): string {
  const parts = [tool.name, tool.name.replaceAll("_", " "), tool.description];
  schemaText(tool.parameters, parts);
  const namespace = tool.namespace;
  if (namespace)
    parts.push(namespace.name, namespace.description ?? "", namespace.instructions ?? "");
  return parts.filter((part) => part.trim()).join(" ");
}

/** Okapi BM25 with the usual parameters. Ties keep document order. */
class Bm25Ranker {
  private readonly k1 = 1.2;
  private readonly b = 0.75;

  rank(query: string, documents: readonly { name: string; text: string }[], limit: number) {
    const queryTerms = [...new Set(tokenize(query))];
    if (queryTerms.length === 0 || documents.length === 0 || limit <= 0) return [];

    const stats = documents.map((document) => {
      const counts = new Map<string, number>();
      for (const term of tokenize(document.text)) counts.set(term, (counts.get(term) ?? 0) + 1);
      return {
        name: document.name,
        counts,
        length: [...counts.values()].reduce((sum, count) => sum + count, 0),
      };
    });
    const averageLength = stats.reduce((sum, stat) => sum + stat.length, 0) / stats.length || 1;
    const idf = new Map(
      queryTerms.map((term) => {
        const frequency = stats.filter((stat) => stat.counts.has(term)).length;
        return [term, Math.log(1 + (stats.length - frequency + 0.5) / (frequency + 0.5))];
      }),
    );

    const matches: { name: string; score: number }[] = [];
    for (const stat of stats) {
      let score = 0;
      for (const term of queryTerms) {
        const count = stat.counts.get(term);
        if (!count) continue;
        const norm = this.k1 * (1 - this.b + (this.b * stat.length) / averageLength);
        score += (idf.get(term) ?? 0) * ((count * (this.k1 + 1)) / (count + norm));
      }
      if (score > 0) matches.push({ name: stat.name, score });
    }

    return matches.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

/**
 * The description a script sees for a tool: Pi's rendered sample, which is what
 * chat's `ALL_TOOLS` entries and `searchTools()` results carry.
 */
export function toolSample(tool: DiscoverableTool): string {
  return renderToolSample({
    name: tool.name,
    description: tool.description,
    inputSchema: (tool.parameters ?? {}) as CodemodeJsonSchema,
    outputSchema: (tool.outputSchema as CodemodeJsonSchema | undefined) ?? TEXT_OUTPUT_SCHEMA,
  });
}

/**
 * Whether `query` names the namespace: its name, its script identifier
 * (`mcp__dev-radius` is `mcp__dev_radius`), or the part after its last `__` in
 * either form (`dev-radius`, `dev_radius`).
 */
function isNamespaceName(namespace: string, query: string): boolean {
  const id = toCodemodeIdentifier(namespace);
  const queryId = toCodemodeIdentifier(query);
  const suffix = (name: string) =>
    name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : undefined;
  return (
    namespace === query || id === queryId || suffix(namespace) === query || suffix(id) === queryId
  );
}

/**
 * `searchTools()`, `describeTool()` and `describeNamespace()` over `tools`, as
 * sandbox globals: same names, arguments and results as the ones Pi puts in a
 * chat's codemode sandbox.
 *
 * `samples` is the per-tool text to hand back — build it with {@link toolSample}
 * so a script reads the same text it would in a chat.
 */
export function createDiscoveryGlobals(
  tools: readonly DiscoverableTool[],
  samples: ReadonlyMap<string, string>,
): CodemodeTool[] {
  const ranker = new Bm25Ranker();
  const documents = tools.map((tool) => ({
    name: tool.name,
    text: toolSearchText(tool),
    namespace: tool.namespace,
  }));

  return [
    {
      name: "searchTools",
      spread: true,
      execute: (args: unknown) => {
        const [query, searchOptions] = args as [
          unknown,
          { limit?: unknown; namespace?: unknown } | undefined,
        ];
        if (typeof query !== "string") throw new Error("searchTools() expects a query string");

        const limit = searchOptions?.limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
        if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
          throw new Error("searchTools() limit must be a positive integer");
        }

        const namespace = searchOptions?.namespace;
        if (namespace !== undefined && namespace !== null && typeof namespace !== "string") {
          throw new Error("searchTools() namespace must be a string");
        }

        // An empty namespace reads as "no filter", as it does in a chat.
        const ranked = ranker.rank(
          query,
          documents.filter(
            (document) =>
              !namespace ||
              (document.namespace !== undefined &&
                isNamespaceName(document.namespace.name, namespace)),
          ),
          limit,
        );

        // What a script gets per match: the name it calls the tool by, and its text.
        return ranked.map((match) => ({
          name: toCodemodeIdentifier(match.name),
          description: samples.get(match.name) ?? "",
        }));
      },
    },
    {
      name: "describeTool",
      spread: true,
      execute: (args: unknown) => {
        const [name] = args as [unknown];
        if (typeof name !== "string") throw new Error("describeTool() expects a tool name");
        const tool = tools.find(
          (candidate) => candidate.name === name || toCodemodeIdentifier(candidate.name) === name,
        );
        return tool ? samples.get(tool.name) : undefined;
      },
    },
    {
      name: "describeNamespace",
      spread: true,
      execute: (args: unknown) => {
        const [name] = args as [unknown];
        if (typeof name !== "string")
          throw new Error("describeNamespace() expects a namespace name");

        // An unknown namespace resolves to `undefined`, so a script can test for one.
        let namespace: DiscoverableTool["namespace"];
        const names: string[] = [];
        for (const tool of tools) {
          if (!tool.namespace || !isNamespaceName(tool.namespace.name, name)) continue;
          namespace ??= tool.namespace;
          names.push(toCodemodeIdentifier(tool.name));
        }
        if (!namespace) return undefined;

        return {
          name: namespace.name,
          ...(namespace.description ? { description: namespace.description } : {}),
          ...(namespace.instructions ? { instructions: namespace.instructions } : {}),
          tools: names,
        };
      },
    },
  ];
}
