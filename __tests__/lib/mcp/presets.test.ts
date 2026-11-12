import { describe, expect, it } from "vitest";
import { findMcpPreset, MCP_PRESETS } from "@/lib/mcp/presets";
import { validateMcpCommand, validateMcpCwd, validateMcpUrl } from "@/lib/mcp/shared";
import { envNameError } from "@/lib/sandbox/env-rules";

describe("MCP presets", () => {
  it("gives every preset a name a tool name can carry", () => {
    for (const preset of MCP_PRESETS) {
      expect(preset.name, preset.id).toMatch(/^(?!.*[-_]{2})[A-Za-z0-9_-]{1,64}$/);
      expect(preset.description.length, preset.id).toBeGreaterThan(0);
    }
  });

  it("carries a valid command or a valid URL, never both", () => {
    for (const preset of MCP_PRESETS) {
      if (preset.transport === "stdio") {
        expect(preset.command, preset.id).toBeTruthy();
        expect(validateMcpCommand(preset.command!), preset.id).toBeNull();
        expect(validateMcpCwd(preset.cwd ?? ""), preset.id).toBeNull();
        expect(preset.url, preset.id).toBeUndefined();
      } else {
        expect(preset.url, preset.id).toBeTruthy();
        expect(validateMcpUrl(preset.url!), preset.id).toBeNull();
        expect(preset.command, preset.id).toBeUndefined();
      }
    }
  });

  it("names only variables the container can carry", () => {
    for (const preset of MCP_PRESETS) {
      for (const variable of preset.variables ?? []) {
        expect(envNameError(variable.name), `${preset.id}: ${variable.name}`).toBeNull();
        expect(variable.what.length, variable.name).toBeGreaterThan(0);
      }
    }
  });

  it("keeps the ids unique and findable", () => {
    const ids = MCP_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(findMcpPreset("github")?.label).toBe("GitHub");
    expect(findMcpPreset("nope")).toBeUndefined();
  });
});
