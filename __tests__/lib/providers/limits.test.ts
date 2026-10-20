import { describe, it, expect } from "vitest";
import {
  PI_DEFAULT_CONTEXT_WINDOW,
  PI_DEFAULT_MAX_OUTPUT_TOKENS,
  limitFields,
  parseModelLimitEdit,
  parseProviderLimits,
  parseTokenLimit,
  resolveModelLimits,
} from "@/lib/providers/limits";
import { definesProviderModels } from "@/lib/providers/config";

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

  it("rejects an output cap larger than the context window it has to fit in", () => {
    // Pi would clamp it silently, leaving a stored number that describes nothing.
    expect(parseProviderLimits("custom", { contextWindow: 8192, maxOutputTokens: 16384 })).toEqual({
      error: "maxOutputTokens cannot exceed contextWindow",
    });
    expect(parseProviderLimits("custom", { contextWindow: 8192, maxOutputTokens: 8192 })).toEqual({
      limits: { contextWindow: 8192, maxOutputTokens: 8192 },
    });
  });
});

describe("parseModelLimitEdit", () => {
  it("keeps a field the body omits out of the edit", () => {
    expect(parseModelLimitEdit({ contextWindow: 32768 })).toEqual({ contextWindow: 32768 });
    expect(parseModelLimitEdit({ maxOutputTokens: 4096 })).toEqual({ maxOutputTokens: 4096 });
  });

  it("reads an explicit null as 'inherit the endpoint default again'", () => {
    expect(parseModelLimitEdit({ contextWindow: null, maxOutputTokens: null })).toEqual({
      contextWindow: null,
      maxOutputTokens: null,
    });
  });

  it("rejects an invalid limit and names it", () => {
    expect(parseModelLimitEdit({ contextWindow: 0 })).toMatchObject({
      error: expect.stringContaining("contextWindow"),
    });
    expect(parseModelLimitEdit({ maxOutputTokens: "8k" })).toMatchObject({
      error: expect.stringContaining("maxOutputTokens"),
    });
  });

  it("rejects an inverted pair sent together", () => {
    expect(parseModelLimitEdit({ contextWindow: 4096, maxOutputTokens: 8192 })).toEqual({
      error: "maxOutputTokens cannot exceed contextWindow",
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

describe("resolveModelLimits", () => {
  const catalog = { contextWindow: 200_000, maxTokens: 64_000 };
  const endpoint = { contextWindow: 32_768, maxOutputTokens: 8_192 };

  it("prefers the model's own value over everything else", () => {
    expect(
      resolveModelLimits({
        model: { contextWindow: 4_096, maxOutputTokens: 1_024 },
        endpoint,
        reported: { contextWindow: 131_072 },
        catalog,
      }),
    ).toEqual({ contextWindow: 4_096, maxTokens: 1_024 });
  });

  it("falls back to the endpoint's default before the endpoint's own report", () => {
    // A default the user typed is a decision; what the server reports is only a
    // better guess than the catalog's.
    expect(resolveModelLimits({ endpoint, reported: { contextWindow: 131_072 }, catalog })).toEqual(
      { contextWindow: 32_768, maxTokens: 8_192 },
    );
  });

  it("uses what the endpoint's listing reported before Pi's catalog", () => {
    // llama-swap serves a model Pi's catalog has at 200k from a 32k instance.
    expect(
      resolveModelLimits({
        endpoint: { contextWindow: null, maxOutputTokens: null },
        reported: { contextWindow: 32_768 },
        catalog,
      }),
    ).toEqual({ contextWindow: 32_768, maxTokens: 64_000 });
  });

  it("falls back to the catalog, then to Pi's defaults, per field", () => {
    expect(resolveModelLimits({ catalog })).toEqual({ contextWindow: 200_000, maxTokens: 64_000 });
    expect(resolveModelLimits({})).toEqual({
      contextWindow: PI_DEFAULT_CONTEXT_WINDOW,
      maxTokens: PI_DEFAULT_MAX_OUTPUT_TOKENS,
    });
    expect(
      resolveModelLimits({
        model: { contextWindow: 8_192 },
        endpoint: { contextWindow: null, maxOutputTokens: 2_048 },
      }),
    ).toEqual({ contextWindow: 8_192, maxTokens: 2_048 });
  });
});

describe("definesProviderModels", () => {
  it("covers Saale's own OpenAI-compatible endpoint", () => {
    expect(definesProviderModels("custom")).toBe(true);
  });

  it("excludes every provider Pi's catalog describes", () => {
    for (const provider of [
      "anthropic",
      "openai",
      "google",
      "deepseek",
      "groq",
      // These used to be discovered from their /models listing; Pi's catalog
      // describes them now, so their limits are Pi's to state.
      "openrouter",
      "together",
      "fireworks",
      "huggingface",
    ]) {
      expect(definesProviderModels(provider)).toBe(false);
    }
  });
});
