import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `/stfu` is the one command whose whole state lives in Redis, so this also
 * pins the isolation boundary: the flag is per user and nothing else may see it.
 */

vi.mock("@/lib/redis", () => import("../../../helpers/in-memory-redis"));

import { resetMockRedis, getRedis } from "../../../helpers/in-memory-redis";
import { stfuHandler } from "@/lib/commands/handlers/stfu";
import { STFU_DURATION_MS } from "@/lib/pi/auto-approve";
import type { WebCommandContext } from "@/lib/commands/types";

const ctx = (userId: string): WebCommandContext => ({
  surface: "web",
  userId,
  sessionId: "session-1",
  args: "",
});

describe("/stfu", () => {
  beforeEach(() => {
    resetMockRedis();
  });

  it("offers enabling and turning off, with 'enable' current while it is off", async () => {
    const prompt = await stfuHandler.prepare!(ctx("u1"));

    expect(prompt.options.map((option) => option.value)).toEqual(["on", "stop"]);
    expect(prompt.options[0]!.current).toBe(true);
    expect(prompt.options[1]!.current).toBe(false);
  });

  it("enables a two-hour window and says until when", async () => {
    const before = Date.now();

    const outcome = await stfuHandler.run(ctx("u1"), "on");

    expect(outcome.tone).toBe("success");
    expect(outcome.message).toMatch(/ON until/);

    const stored = await getRedis().get("saale:auto-approve:u1");
    expect(stored).not.toBeNull();
    const expiry = Number(stored);
    expect(expiry).toBeGreaterThanOrEqual(before + STFU_DURATION_MS - 2_000);
    expect(expiry).toBeLessThanOrEqual(Date.now() + STFU_DURATION_MS + 2_000);
  });

  it("marks the window as current once it is on", async () => {
    await stfuHandler.run(ctx("u1"), "on");

    const prompt = await stfuHandler.prepare!(ctx("u1"));

    expect(prompt.options[1]!.current).toBe(true);
    expect(prompt.description).toMatch(/is on until/);
  });

  it("turns it off again", async () => {
    await stfuHandler.run(ctx("u1"), "on");

    const outcome = await stfuHandler.run(ctx("u1"), "stop");

    expect(outcome.tone).toBe("success");
    expect(await getRedis().get("saale:auto-approve:u1")).toBeNull();
    const prompt = await stfuHandler.prepare!(ctx("u1"));
    expect(prompt.options[1]!.current).toBe(false);
  });

  it("keeps one user's window invisible to another", async () => {
    await stfuHandler.run(ctx("u1"), "on");

    const other = await stfuHandler.prepare!(ctx("u2"));

    expect(other.options[0]!.current).toBe(true);
    expect(other.options[1]!.current).toBe(false);
  });

  it("refuses an unrecognised value instead of changing the approval posture", async () => {
    await stfuHandler.run(ctx("u1"), "on");

    const outcome = await stfuHandler.run(ctx("u1"), "bogus");

    expect(outcome.tone).toBe("error");
    expect(await getRedis().get("saale:auto-approve:u1")).not.toBeNull();
  });
});
