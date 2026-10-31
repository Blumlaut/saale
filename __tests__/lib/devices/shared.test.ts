import { describe, expect, it } from "vitest";
import {
  deviceIdFromUrl,
  deviceUrl,
  readDeviceGroups,
  sanitizeDeviceName,
} from "@/lib/devices/shared";

describe("device names", () => {
  it("folds a hostname into something Pi accepts as a server name", () => {
    expect(sanitizeDeviceName("Workstation.local")).toBe("workstation-local");
    expect(sanitizeDeviceName("Ana's Laptop")).toBe("ana-s-laptop");
    expect(sanitizeDeviceName("  PC  ")).toBe("pc");
  });

  it("falls back when nothing usable is left", () => {
    expect(sanitizeDeviceName("***")).toBe("computer");
    expect(sanitizeDeviceName("", "pc")).toBe("pc");
  });
});

describe("device urls", () => {
  it("round-trips a device id", () => {
    expect(deviceIdFromUrl(deviceUrl("dev-1"))).toBe("dev-1");
  });

  it("only claims device urls", () => {
    expect(deviceIdFromUrl("https://example.com/mcp")).toBeNull();
    expect(deviceIdFromUrl("device://")).toBeNull();
  });
});

describe("capability groups", () => {
  it("keeps the known groups and drops everything else", () => {
    expect(readDeviceGroups(["screen", "clipboard", "terminal", "screen"])).toEqual([
      "screen",
      "terminal",
    ]);
  });

  it("reads a non-list as no groups", () => {
    expect(readDeviceGroups(undefined)).toEqual([]);
    expect(readDeviceGroups("screen")).toEqual([]);
  });
});
