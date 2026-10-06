import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

const { mocks, MockSettingsError } = vi.hoisted(() => {
  class MockSettingsError extends Error {}
  return {
    mocks: { listSettings: vi.fn(), setSetting: vi.fn() },
    MockSettingsError,
  };
});

vi.mock("@/lib/settings/update", () => ({
  listSettings: mocks.listSettings,
  setSetting: mocks.setSetting,
  SettingsError: MockSettingsError,
}));

import { createSettingsTools } from "@/lib/settings/tools";

const USER_ID = "user-1";

function view(key: string, value: unknown, group = key.split(".")[0]!) {
  return { key, group, label: key, description: `${key} description`, scope: "user", value };
}

/** Run a tool and parse its JSON text result. */
async function run(tool: ToolDefinition, params: Record<string, unknown>) {
  const execute = tool.execute as unknown as (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: { type: string; text: string }[] }>;
  const result = await execute("call-1", params);
  const text = result.content[0]?.text;
  if (text === undefined) throw new Error("tool returned no text content");
  return JSON.parse(text) as Record<string, unknown>;
}

function tool(name: string): ToolDefinition {
  const found = createSettingsTools(USER_ID).find((candidate) => candidate.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listSettings.mockResolvedValue([
    view("theme", "system"),
    view("models.default", "anthropic:claude-sonnet-4"),
  ]);
  mocks.setSetting.mockImplementation(async (_userId: string, key: string, value: unknown) =>
    view(key, value),
  );
});

describe("settings tools", () => {
  it("registers settings_list and settings_set only", () => {
    expect(createSettingsTools(USER_ID).map((candidate) => candidate.name)).toEqual([
      "settings_list",
      "settings_set",
    ]);
  });
});

describe("settings_list", () => {
  it("returns a grouped index when unfiltered", async () => {
    const body = await run(tool("settings_list"), {});

    expect(mocks.listSettings).toHaveBeenCalledWith(USER_ID, undefined);
    const groups = body.groups as { group: string; keys: string[] }[];
    expect(groups.map((entry) => entry.group).sort()).toEqual(["models", "theme"]);
    expect(groups.flatMap((entry) => entry.keys).sort()).toEqual(["models.default", "theme"]);
    // The index is key-only — values come from the per-group listing.
    expect(JSON.stringify(body)).not.toContain("anthropic:claude-sonnet-4");
  });

  it("passes a group filter and returns values with descriptions", async () => {
    const body = await run(tool("settings_list"), { group: "tools.category.email" });

    expect(mocks.listSettings).toHaveBeenCalledWith(USER_ID, { group: "tools.category.email" });
    const properties = body.properties as { key: string; value: unknown; description: string }[];
    expect(properties.map((entry) => entry.key)).toEqual(["theme", "models.default"]);
    expect(properties[0]!.description).toContain("description");
  });

  it("passes a key filter", async () => {
    await run(tool("settings_list"), { key: "theme" });

    expect(mocks.listSettings).toHaveBeenCalledWith(USER_ID, { key: "theme" });
  });

  it("errors when a filter matches nothing", async () => {
    mocks.listSettings.mockResolvedValue([]);

    await expect(run(tool("settings_list"), { group: "nope" })).rejects.toThrow(
      /No settings match/,
    );
  });
});

describe("settings_set", () => {
  it("passes the key and value through and reports the stored value", async () => {
    const body = await run(tool("settings_set"), { key: "theme", value: "dark" });

    expect(mocks.setSetting).toHaveBeenCalledWith(USER_ID, "theme", "dark");
    expect(body).toMatchObject({ key: "theme", value: "dark" });
  });

  it("allows an explicit null to reset a setting", async () => {
    await run(tool("settings_set"), { key: "models.default", value: null });

    expect(mocks.setSetting).toHaveBeenCalledWith(USER_ID, "models.default", null);
  });

  it("rejects a call with no value", async () => {
    await expect(run(tool("settings_set"), { key: "theme" })).rejects.toThrow(/value is required/);
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });

  it("rejects a call with no key", async () => {
    await expect(run(tool("settings_set"), { key: "  ", value: 1 })).rejects.toThrow(
      /key is required/,
    );
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });

  it("surfaces a rejected change as a plain error the model can act on", async () => {
    mocks.setSetting.mockRejectedValue(new MockSettingsError('Unknown setting "nope".'));

    await expect(run(tool("settings_set"), { key: "nope", value: 1 })).rejects.toThrow(
      /Unknown setting/,
    );
  });

  it("does not swallow unexpected errors", async () => {
    mocks.setSetting.mockRejectedValue(new Error("database exploded"));

    await expect(run(tool("settings_set"), { key: "theme", value: "dark" })).rejects.toThrow(
      /database exploded/,
    );
  });
});
