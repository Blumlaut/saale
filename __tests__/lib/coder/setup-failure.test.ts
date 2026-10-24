import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetMockRedis } from "../../helpers/in-memory-redis";
import {
  clearSetupFailure,
  getSetupFailure,
  parseSetupFailure,
  recordSetupFailure,
} from "@/lib/coder/setup-failure";

/**
 * The record a chat reads to say its setup script broke.
 *
 * It is written by the run that made the checkout and read by every open tab
 * afterwards, so it has to survive a round trip through JSON and never hand the
 * sidebar something it cannot render. A record it misreads is a warning about
 * nothing, which is worse than no warning.
 */

vi.mock("@/lib/redis", () => import("../../helpers/in-memory-redis"));

describe("parseSetupFailure", () => {
  it("reads back a record it wrote", () => {
    const failedAt = new Date().toISOString();
    expect(parseSetupFailure(JSON.stringify({ exitCode: 1, output: "boom", failedAt }))).toEqual({
      exitCode: 1,
      output: "boom",
      failedAt,
    });
  });

  it("keeps a script that failed without an exit status or output", () => {
    const failedAt = new Date().toISOString();
    expect(parseSetupFailure(JSON.stringify({ exitCode: null, output: "", failedAt }))).toEqual({
      exitCode: null,
      output: "",
      failedAt,
    });
  });

  it("treats anything unusable as no record at all", () => {
    const failedAt = new Date().toISOString();
    expect(parseSetupFailure(null)).toBeNull();
    expect(parseSetupFailure("")).toBeNull();
    expect(parseSetupFailure("not json")).toBeNull();
    expect(parseSetupFailure("[]")).toBeNull();
    // An exit status the panel cannot print.
    expect(parseSetupFailure(JSON.stringify({ exitCode: "1", output: "", failedAt }))).toBeNull();
    expect(parseSetupFailure(JSON.stringify({ exitCode: 1, failedAt }))).toBeNull();
    // A date the panel cannot put beside the error.
    expect(
      parseSetupFailure(JSON.stringify({ exitCode: 1, output: "", failedAt: "soon" })),
    ).toBeNull();
    expect(parseSetupFailure(JSON.stringify({ exitCode: 1, output: "" }))).toBeNull();
  });
});

describe("the setup failure record", () => {
  beforeEach(() => {
    resetMockRedis();
  });

  it("is absent until a setup script fails", async () => {
    expect(await getSetupFailure("session-1")).toBeNull();
  });

  it("keeps the exit status and the output of a failed script", async () => {
    await recordSetupFailure("session-1", { exitCode: 2, output: "npm ERR! missing script" });

    const failure = await getSetupFailure("session-1");
    expect(failure?.exitCode).toBe(2);
    expect(failure?.output).toBe("npm ERR! missing script");
    expect(Number.isNaN(Date.parse(failure!.failedAt))).toBe(false);
  });

  it("is cleared by a build that gets through the script", async () => {
    await recordSetupFailure("session-1", { exitCode: 1, output: "boom" });
    await clearSetupFailure("session-1");

    expect(await getSetupFailure("session-1")).toBeNull();
  });

  it("keeps one chat's failure out of another's", async () => {
    await recordSetupFailure("session-1", { exitCode: 1, output: "boom" });

    expect(await getSetupFailure("session-2")).toBeNull();
    await clearSetupFailure("session-2");
    expect((await getSetupFailure("session-1"))?.output).toBe("boom");
  });

  it("outlives a session but not a month of nobody fixing it", async () => {
    await recordSetupFailure("session-1", { exitCode: 1, output: "boom" });

    const { getRedis } = await import("@/lib/redis");
    const ttl = await getRedis().ttl("coder:setup-failure:session-1");
    // Long enough to come back to the chat tomorrow, short enough to forget.
    expect(ttl).toBeGreaterThan(7 * 24 * 60 * 60);
    expect(ttl).toBeLessThanOrEqual(30 * 24 * 60 * 60);
  });
});
