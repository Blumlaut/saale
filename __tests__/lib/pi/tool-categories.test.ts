import { describe, it, expect } from "vitest";
import {
  TOOL_CATEGORIES,
  DEFAULT_TOOL_CONFIG,
  getToolCategory,
  type ToolConfig,
} from "@/lib/pi/tool-categories";

describe("tool categories", () => {
  it("has 8 tool categories", () => {
    expect(TOOL_CATEGORIES).toHaveLength(8);
  });

  it("has unique keys", () => {
    const keys = TOOL_CATEGORIES.map((c) => c.key);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });

  it("has expected category keys", () => {
    const keys = TOOL_CATEGORIES.map((c) => c.key);
    expect(keys).toContain("bash");
    expect(keys).toContain("files");
    expect(keys).toContain("email");
    expect(keys).toContain("jobs");
    expect(keys).toContain("calendar");
    expect(keys).toContain("chatSearch");
    expect(keys).toContain("web");
    expect(keys).toContain("memory");
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

  it("bash is disabled by default", () => {
    const bash = getToolCategory("bash");
    expect(bash).toBeDefined();
    expect(bash!.defaultEnabled).toBe(false);
  });

  it("all non-bash categories are enabled by default", () => {
    for (const category of TOOL_CATEGORIES) {
      if (category.key === "bash") continue;
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

  it("has bash false and everything else true", () => {
    expect(DEFAULT_TOOL_CONFIG.bash).toBe(false);
    expect(DEFAULT_TOOL_CONFIG.files).toBe(true);
    expect(DEFAULT_TOOL_CONFIG.email).toBe(true);
    expect(DEFAULT_TOOL_CONFIG.jobs).toBe(true);
    expect(DEFAULT_TOOL_CONFIG.calendar).toBe(true);
    expect(DEFAULT_TOOL_CONFIG.chatSearch).toBe(true);
    expect(DEFAULT_TOOL_CONFIG.web).toBe(true);
    expect(DEFAULT_TOOL_CONFIG.memory).toBe(true);
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

describe("ToolConfig type", () => {
  it("accepts partial config objects", () => {
    const config: ToolConfig = { bash: true };
    expect(config.bash).toBe(true);
    expect(config.files).toBeUndefined();
  });

  it("accepts empty config", () => {
    const config: ToolConfig = {};
    expect(Object.keys(config)).toHaveLength(0);
  });

  it("accepts full config", () => {
    const config: ToolConfig = {
      bash: true,
      files: true,
      email: true,
      jobs: true,
      calendar: true,
      chatSearch: true,
      web: true,
      memory: true,
    };
    expect(Object.keys(config)).toHaveLength(8);
  });
});
