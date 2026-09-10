import { describe, it, expect } from "vitest";
import {
  PI_DEFAULT_CONTEXT_WINDOW,
  PI_DEFAULT_MAX_OUTPUT_TOKENS,
  limitFields,
  parseProviderLimits,
  parseTokenLimit,
} from "@/lib/providers/limits";
import { supportsCustomLimits } from "@/lib/providers/config";

describe("parseTokenLimit", () => {
  it("accepts positive integers from numbers and numeric strings", () => {
    expect(parseTokenLimit(32768)).toBe(32768);
    expect(parseTokenLimit("32768")).toBe(32768);
    expect(parseTokenLimit(1)).toBe(1);
  });

  it("treats missing, empty and null as 'not configured'", () => {
    expect(parseTokenLimit(undefined)).toBeNull();
    expect(parseTokenLimit(null)).toBeNull();
    expect(parseTokenLimit("")).toBeNull();
  });

  it("rejects zero, negatives, fractions and non-numeric input", () => {
    expect(parseTokenLimit(0)).toBeUndefined();
    expect(parseTokenLimit(-1)).toBeUndefined();
    expect(parseTokenLimit("-4096")).toBeUndefined();
    expect(parseTokenLimit(1.5)).toBeUndefined();
    expect(parseTokenLimit("lots")).toBeUndefined();
    expect(parseTokenLimit({})).toBeUndefined();
    expect(parseTokenLimit("1e999")).toBeUndefined();
  });
});

describe("parseProviderLimits", () => {
  it("returns limits for an OpenAI-compatible provider", () => {
    expect(parseProviderLimits("custom", { contextWindow: 32768, maxOutputTokens: 8192 })).toEqual({
      limits: { contextWindow: 32768, maxOutputTokens: 8192 },
    });
  });

  it("treats an omitted limit as cleared rather than invalid", () => {
    expect(parseProviderLimits("custom", { contextWindow: 32768 })).toEqual({
      limits: { contextWindow: 32768, maxOutputTokens: null },
    });
  });

  it("always returns both keys so a cleared limit is stored as null", () => {
    const result = parseProviderLimits("custom", {});
    expect(result).toEqual({ limits: { contextWindow: null, maxOutputTokens: null } });
  });

  it("rejects limits for providers whose models come from Pi's catalog", () => {
    const result = parseProviderLimits("anthropic", { maxOutputTokens: 4096 });
    expect(result).toHaveProperty("error");
    expect("limits" in result).toBe(false);
  });

  it("allows an unconfigured provider to be saved without limits", () => {
    // No limits given → nothing to validate against the provider's capabilities.
    expect(parseProviderLimits("anthropic", {})).toEqual({
      limits: { contextWindow: null, maxOutputTokens: null },
    });
  });

  it("reports which field is invalid", () => {
    expect(parseProviderLimits("custom", { contextWindow: "abc" })).toMatchObject({
      error: expect.stringContaining("contextWindow"),
    });
    expect(parseProviderLimits("custom", { maxOutputTokens: -5 })).toMatchObject({
      error: expect.stringContaining("maxOutputTokens"),
    });
  });
});

describe("limitFields", () => {
  it("uses the configured limits when present", () => {
    expect(limitFields({ contextWindow: 32768, maxOutputTokens: 8192 })).toEqual({
      contextWindow: 32768,
      maxTokens: 8192,
    });
  });

  it("falls back to Pi's defaults per field, not per pair", () => {
    expect(limitFields({ contextWindow: 32768, maxOutputTokens: null })).toEqual({
      contextWindow: 32768,
      maxTokens: PI_DEFAULT_MAX_OUTPUT_TOKENS,
    });
    expect(limitFields({ contextWindow: null, maxOutputTokens: 8192 })).toEqual({
      contextWindow: PI_DEFAULT_CONTEXT_WINDOW,
      maxTokens: 8192,
    });
  });
});

describe("supportsCustomLimits", () => {
  it("covers the providers whose models Saale defines itself", () => {
    for (const provider of ["custom", "openrouter", "together", "fireworks", "huggingface"]) {
      expect(supportsCustomLimits(provider)).toBe(true);
    }
  });

  it("excludes catalog-backed providers", () => {
    for (const provider of ["anthropic", "openai", "google", "deepseek", "groq"]) {
      expect(supportsCustomLimits(provider)).toBe(false);
    }
  });
});
