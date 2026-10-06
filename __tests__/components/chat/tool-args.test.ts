import { describe, it, expect } from "vitest";
import { extractScriptToolNames, formatToolArgs } from "@/components/chat/tool-args";

describe("formatToolArgs", () => {
  it("renders string values verbatim, so newlines are real", () => {
    // The bug this exists for: JSON.stringify would emit `"a\nb"` and the
    // <pre> would show a literal backslash-n.
    const text = formatToolArgs({ command: "git fetch\n  && git status" });
    expect(text).toBe("command: git fetch\n  && git status");
    expect(text).not.toContain("\\n");
  });

  it("keeps the JSON form for non-string values", () => {
    expect(formatToolArgs({ limit: 20, deep: { a: 1 } }, { separator: "\n" })).toBe(
      'limit: 20\ndeep: {\n  "a": 1\n}',
    );
  });

  it("compacts non-string values when indent is 0", () => {
    expect(formatToolArgs({ deep: { a: 1 } }, { indent: 0 })).toBe('deep: {"a":1}');
  });

  it("limits entries and picks the separator for a preview", () => {
    expect(formatToolArgs({ a: "1", b: "2", c: "3" }, { maxEntries: 2, separator: "; " })).toBe(
      "a: 1; b: 2",
    );
  });

  it("renders null and undefined without dropping the key", () => {
    expect(formatToolArgs({ a: null, b: undefined }, { separator: " " })).toBe(
      "a: null b: undefined",
    );
  });

  it("returns an empty string for no arguments", () => {
    expect(formatToolArgs({})).toBe("");
  });
});

describe("extractScriptToolNames", () => {
  it("finds the tools a script calls, in first-use order, without duplicates", () => {
    const code = [
      "const a = await tools.infra_exec({ id: 'm1', command: 'ls' });",
      "const b = await tools.memory_search({ query: 'x' });",
      "const c = await tools.infra_exec({ id: 'm1', command: 'pwd' });",
      "return [a, b, c];",
    ].join("\n");

    expect(extractScriptToolNames(code)).toEqual(["infra_exec", "memory_search"]);
  });

  it("tolerates whitespace and no parentheses", () => {
    expect(extractScriptToolNames("await tools . mail_list ()")).toEqual([]);
    expect(extractScriptToolNames("const t = tools.mail_list;")).toEqual([]);
    expect(extractScriptToolNames("tools.chat_respond({ sessionId, message })")).toEqual([
      "chat_respond",
    ]);
  });

  it("returns nothing for a script that calls no tools", () => {
    expect(extractScriptToolNames("return ALL_TOOLS.length;")).toEqual([]);
    expect(extractScriptToolNames("")).toEqual([]);
  });
});
