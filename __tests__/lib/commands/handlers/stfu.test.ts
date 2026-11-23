import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `/stfu` is the one command whose whole state lives in Redis, so this also
 * pins the isolation boundary: the flag belongs to one chat of one account.
 */

vi.mock("@/lib/redis", () => import("../../../helpers/in-memory-redis"));

import { resetMockRedis, getRedis } from "../../../helpers/in-memory-redis";
import { stfuHandler } from "@/lib/commands/handlers/stfu";
import { STFU_DURATION_MS } from "@/lib/pi/auto-approve";
import { webContext } from "../../../helpers/command-context";
import type { CommandContext } from "@/lib/commands/types";

const ctx = (userId: string, sessionId = "session-1") => ({
  ...webContext("stfu"),
  userId,
  sessionId,
});

describe("/stfu", () => {
  beforeEach(() => {
    resetMockRedis();
  });

  it("offers a window, a permanent mode and turning off, with 'enable' current while it is off", async () => {
    const prompt = await stfuHandler.prepare!(ctx("u1"));

    expect(prompt.options.map((option) => option.value)).toEqual(["on", "permanent", "stop"]);
    expect(prompt.options[0]!.current).toBe(true);
    expect(prompt.options[1]!.current).toBe(false);
    expect(prompt.options[2]!.current).toBe(false);
  });

  it("enables a two-hour window and says until when", async () => {
    const before = Date.now();

    const outcome = await stfuHandler.run(ctx("u1"), "on");

    expect(outcome.tone).toBe("success");
    expect(outcome.message).toMatch(/ON until/);

    const stored = await getRedis().get("saale:auto-approve:u1:session-1");
    expect(stored).not.toBeNull();
    const expiry = Number(stored);
    expect(expiry).toBeGreaterThanOrEqual(before + STFU_DURATION_MS - 2_000);
    expect(expiry).toBeLessThanOrEqual(Date.now() + STFU_DURATION_MS + 2_000);
  });

  it("marks the window as current once it is on", async () => {
    await stfuHandler.run(ctx("u1"), "on");

    const prompt = await stfuHandler.prepare!(ctx("u1"));

    expect(prompt.options[2]!.current).toBe(true);
    expect(prompt.options[1]!.current).toBe(false);
    expect(prompt.description).toMatch(/on in this chat until/);
  });

  it("keeps auto-approve on with no expiry when permanent is chosen", async () => {
    const outcome = await stfuHandler.run(ctx("u1"), "permanent");

    expect(outcome.tone).toBe("success");
    expect(outcome.message).toMatch(/permanently/);

    const prompt = await stfuHandler.prepare!(ctx("u1"));
    expect(prompt.options[1]!.current).toBe(true);
    expect(prompt.options[2]!.current).toBe(false);
    expect(prompt.description).toMatch(/until you turn it off/);
  });

  it("switches a permanent mode back to a window", async () => {
    await stfuHandler.run(ctx("u1"), "permanent");

    await stfuHandler.run(ctx("u1"), "on");

    const prompt = await stfuHandler.prepare!(ctx("u1"));
    expect(prompt.options[1]!.current).toBe(false);
    expect(prompt.description).toMatch(/on in this chat until/);
  });

  it("turns it off again", async () => {
    await stfuHandler.run(ctx("u1"), "on");

    const outcome = await stfuHandler.run(ctx("u1"), "stop");

    expect(outcome.tone).toBe("success");
    expect(await getRedis().get("saale:auto-approve:u1:session-1")).toBeNull();
    const prompt = await stfuHandler.prepare!(ctx("u1"));
    expect(prompt.options[2]!.current).toBe(false);
  });

  it("keeps one user's window invisible to another", async () => {
    await stfuHandler.run(ctx("u1"), "on");

    const other = await stfuHandler.prepare!(ctx("u2"));

    expect(other.options[0]!.current).toBe(true);
    expect(other.options[2]!.current).toBe(false);
  });

  it("keeps the window inside the chat it was set in", async () => {
    await stfuHandler.run(ctx("u1", "chat-a"), "permanent");

    const mine = await stfuHandler.prepare!(ctx("u1", "chat-a"));
    expect(mine.options[1]!.current).toBe(true);

    const other = await stfuHandler.prepare!(ctx("u1", "chat-b"));
    expect(other.options[0]!.current).toBe(true);
    expect(other.description).toMatch(/in this chat/);
  });

  it("has nothing to switch on without a chat", async () => {
    // A Telegram message that starts a conversation: there is no chat to scope it to.
    const ctxNoChat: CommandContext = {
      ...webContext("stfu"),
      surface: "telegram",
      sessionId: undefined,
      telegramChatId: BigInt(1),
      encryptedToken: "token",
    };

    const prompt = await stfuHandler.prepare!(ctxNoChat);
    expect(prompt.options).toEqual([]);

    const outcome = await stfuHandler.run(ctxNoChat, "on");
    expect(outcome.tone).toBe("info");
    expect(await getRedis().get("saale:auto-approve:user-1:undefined")).toBeNull();
  });

  it("refuses an unrecognised value instead of changing the approval posture", async () => {
    await stfuHandler.run(ctx("u1"), "on");

    const outcome = await stfuHandler.run(ctx("u1"), "bogus");

    expect(outcome.tone).toBe("error");
    expect(await getRedis().get("saale:auto-approve:u1:session-1")).not.toBeNull();
  });
});
