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

  it("keeps a category that differs from its default", () => {
    // infra defaults to codemode, so `deferred` is the deviation worth storing.
    expect(normalizeToolExposure({ infra: "deferred" })).toEqual({ infra: "deferred" });
    // web defaults to direct, so `codemode` is the deviation.
    expect(normalizeToolExposure({ web: "codemode", memory: "direct" })).toEqual({
      web: "codemode",
    });
  });

  it("drops unknown categories, unknown exposures and entries at the default", () => {
    expect(
      normalizeToolExposure({
        email: "codemode", // email's default — stored as absence
        web: "codemode", // a real deviation
        jobs: "direct", // jobs defaults to codemode — a real deviation
        nope: "deferred", // not a category
        memory: "sometimes", // not an exposure
        calendar: 42,
      }),
    ).toEqual({ web: "codemode", jobs: "direct" });
  });

  it("returns null when nothing survives", () => {
    expect(normalizeToolExposure({ email: "codemode", infra: "codemode" })).toBeNull();
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
    mockFindUnique.mockResolvedValue({ toolExposure: { email: "direct", bogus: "x" } });
    expect(await loadToolExposure("user-1")).toEqual({ email: "direct" });
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
        { web: "codemode", jobs: "deferred" },
        { jobs: "deferred", web: "codemode" },
      ),
    ).toBe(true);
  });

  it("treats null, undefined and an empty map as the same unset setting", () => {
    expect(toolExposureEquals(null, undefined)).toBe(true);
    expect(toolExposureEquals(null, {})).toBe(true);
    expect(toolExposureEquals(undefined, {})).toBe(true);
  });

  it("detects added, removed and changed categories", () => {
    expect(toolExposureEquals({ web: "codemode" }, { web: "codemode", jobs: "deferred" })).toBe(
      false,
    );
    expect(toolExposureEquals({ web: "codemode" }, { web: "deferred" })).toBe(false);
    expect(toolExposureEquals({ web: "codemode" }, null)).toBe(false);
  });
});
