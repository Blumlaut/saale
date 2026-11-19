import { describe, expect, it } from "vitest";
import {
  MACHINE_FILE_TARGET_PREFIX,
  USER_FILE_TARGET,
  machineFileTarget,
  parseFileTargetToken,
} from "@/lib/files/target-tokens";

describe("file target tokens", () => {
  it("names one machine's files", () => {
    expect(machineFileTarget("abc123")).toBe(`${MACHINE_FILE_TARGET_PREFIX}abc123`);
  });

  it("reads the user's own workspace from nothing at all", () => {
    expect(parseFileTargetToken(null)).toEqual({ kind: "workspace" });
    expect(parseFileTargetToken("")).toEqual({ kind: "workspace" });
    expect(parseFileTargetToken(USER_FILE_TARGET)).toEqual({ kind: "workspace" });
  });

  it("reads a machine id out of its token", () => {
    expect(parseFileTargetToken(machineFileTarget("abc123"))).toEqual({
      kind: "machine",
      machineId: "abc123",
    });
  });

  it("refuses a token that names no machine", () => {
    expect(parseFileTargetToken(MACHINE_FILE_TARGET_PREFIX)).toBeNull();
  });

  it("refuses a target it does not know", () => {
    expect(parseFileTargetToken("elsewhere:/tmp")).toBeNull();
    expect(parseFileTargetToken("machine")).toBeNull();
    expect(parseFileTargetToken("/workspace")).toBeNull();
  });
});
