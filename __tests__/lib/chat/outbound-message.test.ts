import { describe, it, expect } from "vitest";
import {
  dropOptimistic,
  placementForSend,
  settleQueuedMessage,
  settleSentMessage,
} from "@/lib/chat/outbound-message";
import type { Message } from "@/components/chat/types";

function msg(id: string, content = id): Message {
  return {
    id,
    role: "user",
    content,
    thinking: undefined,
    toolCalls: undefined,
    parentMessageId: undefined,
    createdAt: "2026-01-01T00:00:00.000Z",
    attachments: undefined,
  };
}

describe("placementForSend", () => {
  it("queues while the session is busy, shows in the conversation otherwise", () => {
    expect(placementForSend(true)).toBe("queue");
    expect(placementForSend(false)).toBe("conversation");
  });
});

describe("settleSentMessage", () => {
  it("swaps the optimistic copy for the saved row in place", () => {
    const list = [msg("db-1"), msg("temp-1"), msg("db-2")];
    const saved = msg("db-3", "hello");

    expect(settleSentMessage(list, msg("temp-1", "hello"), saved).map((m) => m.id)).toEqual([
      "db-1",
      "db-3",
      "db-2",
    ]);
  });

  it("appends the saved row when the optimistic copy was placed in the queue", () => {
    const list = [msg("db-1"), msg("streaming-t1")];

    expect(settleSentMessage(list, msg("temp-1"), msg("db-2")).map((m) => m.id)).toEqual([
      "db-1",
      "streaming-t1",
      "db-2",
    ]);
  });

  it("does not duplicate a saved row a DB reload already delivered", () => {
    const saved = msg("db-2");
    const list = [msg("db-1"), saved];

    expect(settleSentMessage(list, msg("temp-1"), saved)).toBe(list);
  });
});

describe("settleQueuedMessage", () => {
  it("appends the saved row to the queue strip", () => {
    const list = [msg("db-old")];

    expect(settleQueuedMessage(list, msg("temp-1"), msg("db-1")).map((m) => m.id)).toEqual([
      "db-old",
      "db-1",
    ]);
  });

  it("keeps the position the server published when the SSE update wins the race", () => {
    // The queue_update for the enqueue arrived first, and another message was
    // queued after it  re-appending would jump ours past that one.
    const saved = msg("db-1");
    const list = [saved, msg("db-2")];

    expect(settleQueuedMessage(list, msg("temp-1"), saved).map((m) => m.id)).toEqual([
      "db-1",
      "db-2",
    ]);
  });
});

describe("dropOptimistic", () => {
  it("removes one or several ids and leaves the rest untouched", () => {
    const list = [msg("db-1"), msg("temp-1"), msg("db-2")];

    expect(dropOptimistic(list, msg("temp-1")).map((m) => m.id)).toEqual(["db-1", "db-2"]);
    expect(dropOptimistic(list, msg("temp-1"), msg("db-1")).map((m) => m.id)).toEqual(["db-2"]);
  });
});
