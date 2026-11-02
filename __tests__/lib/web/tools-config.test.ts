import { describe, expect, it } from "vitest";

import {
  clampSetting,
  DEFAULT_MAX_CHARS,
  MAX_RESULTS_PER_CALL,
  resolveFetchCall,
  resolveSearchCall,
  safeSearchLevel,
  type WebFetchSettings,
  type WebSearchSettings,
} from "@/lib/web/tools-config";

const unrestricted: WebSearchSettings = {
  engines: [],
  categories: ["general"],
  safeSearch: 0,
  language: "all",
  resultsPerCall: 10,
};

const pinned: WebSearchSettings = {
  ...unrestricted,
  engines: ["duckduckgo", "wikipedia"],
  language: "de",
};

const fetchBudget: WebFetchSettings = { maxChars: 20_000, timeoutMs: 8_000, maxRedirects: 3 };

describe("resolveSearchCall", () => {
  it("searches every engine of the category when none is configured", () => {
    expect(resolveSearchCall(unrestricted, {})).toEqual({
      categories: "general",
      language: "all",
      safeSearch: 0,
      maxResults: 10,
    });
  });

  it("runs on the configured engines only, and leaves the category out", () => {
    const call = resolveSearchCall(pinned, { engines: "duckduckgo,bing" });

    expect(call.engines).toBe("duckduckgo");
    expect(call.categories).toBeUndefined();
  });

  it("asks for the configured engines when the model names none", () => {
    const call = resolveSearchCall(pinned, { categories: "news" });

    expect(call.engines).toBe("duckduckgo,wikipedia");
    expect(call.categories).toBeUndefined();
  });

  it("keeps a model's categories and language when nothing is pinned", () => {
    const call = resolveSearchCall(unrestricted, { categories: "news", language: "fr" });

    expect(call.categories).toBe("news");
    expect(call.language).toBe("fr");
  });

  it("falls back to the configured language for a blank request", () => {
    expect(resolveSearchCall(pinned, { language: "  " }).language).toBe("de");
  });

  it("keeps the result count within the ceiling", () => {
    expect(resolveSearchCall(unrestricted, { limit: 500 }).maxResults).toBe(MAX_RESULTS_PER_CALL);
    expect(resolveSearchCall(unrestricted, {}).maxResults).toBe(10);
  });

  it("passes a time range through", () => {
    expect(resolveSearchCall(unrestricted, { timeRange: "day" }).timeRange).toBe("day");
  });
});

describe("resolveFetchCall", () => {
  it("uses the configured budget by default", () => {
    expect(resolveFetchCall(fetchBudget, {})).toEqual(fetchBudget);
  });

  it("lets the model ask for fewer characters and a shorter timeout", () => {
    expect(resolveFetchCall(fetchBudget, { maxChars: 5_000, timeoutMs: 3_000 })).toEqual({
      maxChars: 5_000,
      timeoutMs: 3_000,
      maxRedirects: 3,
    });
  });

  it("holds a request outside the bounds inside them", () => {
    const call = resolveFetchCall(fetchBudget, { maxChars: 10, timeoutMs: 10 });

    expect(call.maxChars).toBe(1_000);
    expect(call.timeoutMs).toBe(1_000);
  });
});

describe("clampSetting", () => {
  it.each([
    [10, 1, 50, 10],
    [0, 1, 50, 1],
    [99, 1, 50, 50],
    [Number.NaN, 1, 50, 7],
    [12.4, 1, 50, 12],
  ])("holds %j between %i and %i", (value, min, max, expected) => {
    expect(clampSetting(value, min, max, 7)).toBe(expected);
  });

  it("keeps the default character budget at 50k", () => {
    expect(DEFAULT_MAX_CHARS).toBe(50_000);
  });
});

describe("safeSearchLevel", () => {
  it("keeps 1 and 2 and drops everything else to off", () => {
    expect(safeSearchLevel(1)).toBe(1);
    expect(safeSearchLevel(2)).toBe(2);
    expect(safeSearchLevel(7)).toBe(0);
  });
});
