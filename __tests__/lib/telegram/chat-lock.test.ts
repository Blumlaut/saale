import { describe, it, expect } from "vitest";
import { withChatLock, pendingChatLocks } from "@/lib/telegram/chat-lock";

/**
 * Telegram's webhook acknowledges an update and processes it in the
 * background, so two messages from one chat can be in flight at once. They
 * share the chat's transcript directory — and, for the first message, race to
 * create the chat's `ChatSession` row.
 */

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("withChatLock", () => {
  it("runs work for one chat strictly one at a time", async () => {
    const events: string[] = [];
    const work = (id: string) => async () => {
      events.push(`start:${id}`);
      await tick(20);
      events.push(`end:${id}`);
    };

    await Promise.all([
      withChatLock("user:1", work("a")),
      withChatLock("user:1", work("b")),
      withChatLock("user:1", work("c")),
    ]);

    // No interleaving: each run finishes before the next starts.
    expect(events).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
  });

  it("does not serialize different chats", async () => {
    const events: string[] = [];
    const work = (id: string) => async () => {
      events.push(`start:${id}`);
      await tick(20);
      events.push(`end:${id}`);
    };

    await Promise.all([
      withChatLock("user:1", work("chat-1")),
      withChatLock("user:2", work("chat-2")),
    ]);

    expect(events).toEqual(["start:chat-1", "start:chat-2", "end:chat-1", "end:chat-2"]);
  });

  it("keeps running queued work after a failure and reports that failure", async () => {
    const ran: string[] = [];

    const failing = withChatLock("user:1", async () => {
      ran.push("failing");
      throw new Error("boom");
    });
    const following = withChatLock("user:1", async () => {
      ran.push("following");
      return "ok";
    });

    await expect(failing).rejects.toThrow("boom");
    await expect(following).resolves.toBe("ok");
    expect(ran).toEqual(["failing", "following"]);
  });

  it("drops the lock once the queue drains", async () => {
    await withChatLock("user:1", async () => {});
    await withChatLock("user:2", async () => {
      throw new Error("boom");
    }).catch(() => undefined);
    await tick();

    expect(pendingChatLocks()).toBe(0);
  });
});
