import { describe, expect, it } from "vitest";
import { mergeOwnedRows } from "@/lib/shared-resources";
import { mcpNameKey } from "@/lib/mcp/shared";

function row(name: string, extra: Record<string, unknown> = {}) {
  return { name, ...extra };
}

describe("mergeOwnedRows", () => {
  it("offers the account's own rows before the instance's", () => {
    const merged = mergeOwnedRows({ own: [row("mine")], shared: [row("house")] });

    expect(merged).toEqual([
      { name: "mine", shared: false },
      { name: "house", shared: true },
    ]);
  });

  it("keeps the account's row when both sides use one name", () => {
    const merged = mergeOwnedRows({
      own: [row("review", { content: "mine" })],
      shared: [row("review", { content: "house" })],
    });

    expect(merged).toEqual([{ name: "review", content: "mine", shared: false }]);
  });

  it("compares names the way the caller folds them", () => {
    // Pi treats `-` and `_` as one character in a server name.
    const merged = mergeOwnedRows({
      own: [row("home-assistant", { url: "https://mine/mcp" })],
      shared: [row("home_assistant", { url: "https://house/mcp" }), row("docs")],
      keyOf: (server) => mcpNameKey(server.name),
    });

    expect(merged.map((server) => server.name)).toEqual(["home-assistant", "docs"]);
    expect(merged.map((server) => server.shared)).toEqual([false, true]);
  });

  it("collapses two rows of one name on the same side", () => {
    const merged = mergeOwnedRows({
      own: [],
      shared: [row("home-assistant"), row("home_assistant")],
      keyOf: (server) => mcpNameKey(server.name),
    });

    expect(merged).toEqual([{ name: "home-assistant", shared: true }]);
  });

  it("returns an empty set when neither side has a row", () => {
    expect(mergeOwnedRows({ own: [], shared: [] })).toEqual([]);
  });
});
