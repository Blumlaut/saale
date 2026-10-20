import { describe, it, expect } from "vitest";
import {
  DEFAULT_THINKING_LEVEL_SETTING,
  PI_THINKING_LEVELS,
  THINKING_LEVEL_OPTIONS,
  isPiThinkingLevel,
  isThinkingLevelSetting,
  normalizeThinkingLevelSetting,
  thinkingLevelOption,
  thinkingLevelOptionsFor,
} from "@/lib/pi/thinking-levels";

describe("THINKING_LEVEL_OPTIONS", () => {
  it("offers 'default' alongside every level Pi accepts", () => {
    const ids = THINKING_LEVEL_OPTIONS.map((o) => o.id);
    expect(ids).toEqual(["default", ...PI_THINKING_LEVELS]);
  });

  it("keeps Pi's order, cheapest to deepest", () => {
    expect(PI_THINKING_LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("has a label and description for every option", () => {
    for (const option of THINKING_LEVEL_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.description.length).toBeGreaterThan(0);
    }
  });

  it("keeps 'default' distinct from 'off'", () => {
    // "off" is an explicit instruction to Pi; "default" means Saale has none.
    expect(THINKING_LEVEL_OPTIONS.map((o) => o.id)).toContain("off");
    expect(DEFAULT_THINKING_LEVEL_SETTING).toBe("default");
  });
});

describe("thinkingLevelOption", () => {
  it("omits the SDK option when the setting is 'default'", () => {
    // Omitting is what lets Pi keep the level recorded in the session file,
    // the user's Pi setting, or its built-in default.
    expect(thinkingLevelOption("default")).toEqual({});
    expect(thinkingLevelOption(undefined)).toEqual({});
    expect(thinkingLevelOption(null)).toEqual({});
    expect(thinkingLevelOption("")).toEqual({});
  });

  it("passes every real level through", () => {
    for (const level of PI_THINKING_LEVELS) {
      expect(thinkingLevelOption(level)).toEqual({ thinkingLevel: level });
    }
  });

  it("treats an unknown level as 'no opinion' rather than guessing", () => {
    expect(thinkingLevelOption("banana")).toEqual({});
    expect(thinkingLevelOption("OFF")).toEqual({});
  });

  it("spreads into SDK options without clobbering other fields", () => {
    const options = { model: "m", ...thinkingLevelOption("high") };
    expect(options).toEqual({ model: "m", thinkingLevel: "high" });
    expect({ model: "m", ...thinkingLevelOption("default") }).toEqual({ model: "m" });
  });
});

describe("thinkingLevelOptionsFor", () => {
  it("offers every level while the model's levels are unknown", () => {
    expect(thinkingLevelOptionsFor(null)).toEqual(THINKING_LEVEL_OPTIONS);
  });

  it("drops levels the model lacks but keeps 'default'", () => {
    const ids = thinkingLevelOptionsFor(["low", "high", "max"]).map((o) => o.id);
    expect(ids).toEqual(["default", "low", "high", "max"]);
  });

  it("matches on the exact level, not a prefix", () => {
    const ids = thinkingLevelOptionsFor(["high", "xhigh"]).map((o) => o.id);
    expect(ids).toEqual(["default", "high", "xhigh"]);
  });
});

describe("normalizeThinkingLevelSetting", () => {
  it("keeps valid settings untouched", () => {
    for (const option of THINKING_LEVEL_OPTIONS) {
      expect(normalizeThinkingLevelSetting(option.id)).toBe(option.id);
    }
  });

  it("falls back to 'default' for anything else", () => {
    for (const invalid of ["", "banana", null, undefined, 5, {}, "OFF"]) {
      expect(normalizeThinkingLevelSetting(invalid)).toBe(DEFAULT_THINKING_LEVEL_SETTING);
    }
  });
});

describe("isThinkingLevelSetting", () => {
  it("accepts stored settings and rejects Pi-only or bogus values", () => {
    expect(isThinkingLevelSetting("default")).toBe(true);
    expect(isThinkingLevelSetting("medium")).toBe(true);
    expect(isThinkingLevelSetting("bogus")).toBe(false);
    expect(isThinkingLevelSetting(undefined)).toBe(false);
  });

  it("treats 'default' as a setting but not a Pi level", () => {
    expect(isThinkingLevelSetting("default")).toBe(true);
    expect(isPiThinkingLevel("default")).toBe(false);
  });
});
