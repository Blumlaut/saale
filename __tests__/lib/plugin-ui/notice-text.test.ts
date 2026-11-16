import { describe, expect, it } from "vitest";
import { saaleNotice } from "@/lib/plugin-ui/notice-text";

describe("saaleNotice", () => {
  it("sends an MCP hint to the page that holds the settings", () => {
    const message = saaleNotice(
      "MCP servers need attention:\n  stackoverflow: needs sign-in\nRun /mcp to fix.",
    );

    expect(message).toBe(
      "MCP servers need attention:\n  stackoverflow: needs sign-in\nSign in from Settings → Integrations.",
    );
    expect(message).not.toContain("/mcp");
  });

  it("rewrites a named sign-in on the same line", () => {
    expect(saaleNotice("stackoverflow: needs sign-in, run /mcp login stackoverflow")).toBe(
      "stackoverflow: needs sign-in, sign in from Settings → Integrations",
    );
  });

  it("leaves a notice that names no command alone", () => {
    const message = "Search engines are unreachable.";
    expect(saaleNotice(message)).toBe(message);
  });
});
