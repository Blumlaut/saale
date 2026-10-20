import { describe, expect, it } from "vitest";
import { getAllToolDefinitions } from "@/lib/pi/tool-registry";
import { TOOL_CATEGORIES } from "@/lib/pi/tool-categories";

/**
 * What every tool promises a programmatic caller.
 *
 * A codemode script and a watcher tick receive a tool's `structuredContent`, but
 * only for tools that declare an `outputSchema`  otherwise they get the
 * model-facing text, which carries UI metadata and an echo of the call's own
 * arguments. A tool that skips the declaration is therefore not a cosmetic
 * omission: it hands scripts text they have to parse and can match against
 * their own query.
 *
 * The definitions here are the real ones, built by the same registry the
 * session uses, so a tool added to any category is covered without being
 * listed a second time in this file.
 */
describe("tool results", () => {
  const tools = getAllToolDefinitions("test-user", "test-session");

  it("builds a definition for every category", () => {
    const categories = TOOL_CATEGORIES.filter((c) => c.key !== "terminal");

    // Guards the check below from passing because nothing was built at all.
    expect(categories.length).toBeGreaterThan(0);
    expect(tools.length).toBeGreaterThan(50);
  });

  it("gives every tool an output schema", () => {
    const missing = tools.filter((tool) => !tool.outputSchema).map((tool) => tool.name);

    expect(missing, "tools that would hand scripts their model-facing text").toEqual([]);
  });

  it("names every tool once", () => {
    const names = tools.map((tool) => tool.name);
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index);

    expect(duplicates).toEqual([]);
  });

  it("describes every output as something a script can read a field from", () => {
    const wrong = tools
      .filter((tool) => !isReadableOutput(tool.outputSchema))
      .map((tool) => tool.name);

    // A schema that is not an object (or a union of them) gives a script nothing
    // to read a field from, which is the whole point of taking the text out of
    // its hands.
    expect(wrong).toEqual([]);
  });
});

/** An object schema, or a union of them: a value with named fields. */
function isReadableOutput(schema: unknown): boolean {
  const node = schema as { type?: string; properties?: unknown; anyOf?: unknown[] } | undefined;
  if (!node) return false;
  if (node.type === "object" && Boolean(node.properties)) return true;

  return Array.isArray(node.anyOf) && node.anyOf.length > 0 && node.anyOf.every(isReadableOutput);
}
