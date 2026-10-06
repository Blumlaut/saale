import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `toolExposure` is JSON that arrives from a client PATCH and is read back on
 * every session build, so it is normalized instead of trusted. A bad value must
 * never reach a tool definition: Pi ignores an unknown exposure and would treat
 * the tool as `direct`, i.e. the opposite of what the user asked for.
 */

const mockFindUnique = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: { appSettings: { findUnique: (...args: unknown[]) => mockFindUnique(...args) } },
}));

import {
  loadToolExposure,
  normalizeToolExposure,
  toolExposureEquals,
} from "@/lib/pi/tool-exposure";

describe("normalizeToolExposure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps known categories with a known exposure", () => {
    expect(normalizeToolExposure({ email: "codemode", infra: "deferred" })).toEqual({
      email: "codemode",
      infra: "deferred",
    });
  });

  it("drops unknown categories, unknown exposures and direct entries", () => {
    expect(
      normalizeToolExposure({
        email: "codemode",
        jobs: "direct", // the default — stored as absence
        nope: "deferred", // not a category
        web: "sometimes", // not an exposure
        memory: 42,
      }),
    ).toEqual({ email: "codemode" });
  });

  it("returns null when nothing survives", () => {
    expect(normalizeToolExposure({ jobs: "direct" })).toBeNull();
    expect(normalizeToolExposure({})).toBeNull();
  });

  it("rejects non-object values", () => {
    for (const value of [null, undefined, "codemode", 7, ["codemode"], true]) {
      expect(normalizeToolExposure(value)).toBeNull();
    }
  });
});

describe("loadToolExposure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads and normalizes the user's stored exposure", async () => {
    mockFindUnique.mockResolvedValue({ toolExposure: { email: "codemode", bogus: "x" } });
    expect(await loadToolExposure("user-1")).toEqual({ email: "codemode" });
    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      select: { toolExposure: true },
    });
  });

  it("returns null when the user has no settings row", async () => {
    mockFindUnique.mockResolvedValue(null);
    expect(await loadToolExposure("user-2")).toBeNull();
  });
});

describe("toolExposureEquals", () => {
  it("ignores key order", () => {
    // The route compares the stored value to the incoming one to decide whether
    // a pooled chat has to be rebuilt; a reordered object is the same setting.
    expect(
      toolExposureEquals(
        { email: "codemode", jobs: "deferred" },
        { jobs: "deferred", email: "codemode" },
      ),
    ).toBe(true);
  });

  it("treats null, undefined and an empty map as the same unset setting", () => {
    expect(toolExposureEquals(null, undefined)).toBe(true);
    expect(toolExposureEquals(null, {})).toBe(true);
    expect(toolExposureEquals(undefined, {})).toBe(true);
  });

  it("detects added, removed and changed categories", () => {
    expect(toolExposureEquals({ email: "codemode" }, { email: "codemode", jobs: "deferred" })).toBe(
      false,
    );
    expect(toolExposureEquals({ email: "codemode" }, { email: "deferred" })).toBe(false);
    expect(toolExposureEquals({ email: "codemode" }, null)).toBe(false);
  });
});
