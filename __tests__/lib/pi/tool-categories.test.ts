import { describe, it, expect } from "vitest";
import {
  TOOL_CATEGORIES,
  DEFAULT_TOOL_CONFIG,
  getToolCategory,
  hasCodemodeCategory,
  isCategoryEnabled,
  type ToolConfig,
} from "@/lib/pi/tool-categories";

describe("tool categories", () => {
  it("has 14 tool categories", () => {
    expect(TOOL_CATEGORIES).toHaveLength(14);
  });

  it("has unique keys", () => {
    const keys = TOOL_CATEGORIES.map((c) => c.key);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });

  it("has expected category keys", () => {
    const keys = TOOL_CATEGORIES.map((c) => c.key);
    expect(keys).toContain("terminal");
    expect(keys).toContain("email");
    expect(keys).toContain("jobs");
    expect(keys).toContain("calendar");
    expect(keys).toContain("chatSearch");
    expect(keys).toContain("telegram");
    expect(keys).toContain("web");
    expect(keys).toContain("memory");
    expect(keys).toContain("tasks");
    expect(keys).toContain("agentJobs");
    expect(keys).toContain("infra");
    expect(keys).toContain("settings");
  });

  it("each category has required fields", () => {
    for (const category of TOOL_CATEGORIES) {
      expect(category.key).toBeTypeOf("string");
      expect(category.key).not.toBe("");
      expect(category.label).toBeTypeOf("string");
      expect(category.label).not.toBe("");
      expect(category.description).toBeTypeOf("string");
      expect(category.description).not.toBe("");
      expect(category.icon).toBeDefined();
      expect(typeof category.defaultEnabled).toBe("boolean");
    }
  });

  it("every category is enabled by default", () => {
    for (const category of TOOL_CATEGORIES) {
      expect(category.defaultEnabled).toBe(true);
    }
  });
});

describe("DEFAULT_TOOL_CONFIG", () => {
  it("has an entry for every category", () => {
    for (const category of TOOL_CATEGORIES) {
      expect(DEFAULT_TOOL_CONFIG).toHaveProperty(category.key);
    }
  });

  it("matches category defaultEnabled values", () => {
    for (const category of TOOL_CATEGORIES) {
      expect(DEFAULT_TOOL_CONFIG[category.key]).toBe(category.defaultEnabled);
    }
  });

  it("has every category enabled", () => {
    expect(DEFAULT_TOOL_CONFIG.terminal).toBe(true);
    expect(DEFAULT_TOOL_CONFIG.email).toBe(true);
    expect(DEFAULT_TOOL_CONFIG.jobs).toBe(true);
    expect(DEFAULT_TOOL_CONFIG.calendar).toBe(true);
    expect(DEFAULT_TOOL_CONFIG.chatSearch).toBe(true);
    expect(DEFAULT_TOOL_CONFIG.telegram).toBe(true);
    expect(DEFAULT_TOOL_CONFIG.web).toBe(true);
    expect(DEFAULT_TOOL_CONFIG.memory).toBe(true);
    expect(DEFAULT_TOOL_CONFIG.tasks).toBe(true);
    expect(DEFAULT_TOOL_CONFIG.agentJobs).toBe(true);
    expect(DEFAULT_TOOL_CONFIG.infra).toBe(true);
    expect(DEFAULT_TOOL_CONFIG.settings).toBe(true);
  });
});

describe("getToolCategory", () => {
  it("returns category for valid keys", () => {
    const email = getToolCategory("email");
    expect(email).toBeDefined();
    expect(email!.key).toBe("email");
    expect(email!.label).toBe("Email");
  });

  it("returns undefined for invalid keys", () => {
    expect(getToolCategory("nonexistent")).toBeUndefined();
    expect(getToolCategory("")).toBeUndefined();
  });

  it("is case-sensitive", () => {
    expect(getToolCategory("Email")).toBeUndefined();
    expect(getToolCategory("EMAIL")).toBeUndefined();
  });
});

describe("isCategoryEnabled", () => {
  it("reads an absent key as the category default", () => {
    // A sparse config (or one saved before the category existed) must not read
    // as off, or a newly added category disappears for existing users.
    expect(isCategoryEnabled({}, "settings")).toBe(true);
    expect(isCategoryEnabled({ terminal: true }, "settings")).toBe(true);
    expect(isCategoryEnabled(null, "terminal")).toBe(true);
    expect(isCategoryEnabled(undefined, "memory")).toBe(true);
  });

  it("honours an explicit value", () => {
    expect(isCategoryEnabled({ settings: false }, "settings")).toBe(false);
    expect(isCategoryEnabled({ email: false }, "email")).toBe(false);
    expect(isCategoryEnabled({ web: true }, "web")).toBe(true);
  });

  it("treats an unknown category as off", () => {
    expect(isCategoryEnabled({}, "nope")).toBe(false);
    expect(isCategoryEnabled({ nope: true }, "nope")).toBe(true);
  });
});

describe("ToolConfig type", () => {
  it("accepts partial config objects", () => {
    const config: ToolConfig = { terminal: true };
    expect(config.terminal).toBe(true);
    expect(config.email).toBeUndefined();
  });

  it("accepts empty config", () => {
    const config: ToolConfig = {};
    expect(Object.keys(config)).toHaveLength(0);
  });

  it("accepts full config", () => {
    const config: ToolConfig = {
      terminal: true,
      email: true,
      jobs: true,
      calendar: true,
      chatSearch: true,
      telegram: true,
      web: true,
      memory: true,
      tasks: true,
      agentJobs: true,
      infra: false,
      settings: true,
    };
    expect(Object.keys(config)).toHaveLength(12);
  });
});

describe("hasCodemodeCategory", () => {
  it("is true for the defaults, where most categories go through codemode", () => {
    expect(hasCodemodeCategory({})).toBe(true);
  });

  it("is false when every enabled category is declared in full", () => {
    const config = Object.fromEntries(
      TOOL_CATEGORIES.map((c) => [c.key, c.defaultExposure === "direct"]),
    );
    expect(hasCodemodeCategory(config)).toBe(false);
  });

  it("follows the exposure a category was moved to", () => {
    const onlyTerminal = Object.fromEntries(
      TOOL_CATEGORIES.map((c) => [c.key, c.key === "terminal"]),
    );
    expect(hasCodemodeCategory(onlyTerminal)).toBe(false);
    // Settings on, but every one of its tools declared: nothing behind codemode.
    const withSettings = { ...onlyTerminal, settings: true };
    expect(hasCodemodeCategory(withSettings, { settings: "direct" })).toBe(false);
    expect(hasCodemodeCategory(withSettings)).toBe(true);
  });
});
