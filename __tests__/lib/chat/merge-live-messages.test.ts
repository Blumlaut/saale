import { describe, it, expect } from "vitest";
import { mergeMessagesWithLive } from "@/lib/chat/merge-live-messages";
import type { Message } from "@/components/chat/types";

function makeMessage(overrides: Partial<Message> & { id: string }): Message {
  return {
    role: "user",
    content: "",
    thinking: undefined,
    toolCalls: undefined,
    parentMessageId: undefined,
    createdAt: new Date().toISOString(),
    attachments: undefined,
    ...overrides,
  };
}

describe("mergeMessagesWithLive", () => {
  it("appends live messages after the DB snapshot in order", () => {
    const db = [makeMessage({ id: "db-1", content: "saved" })];
    const prev = [
      makeMessage({ id: "streaming-abc", role: "assistant", content: "in-flight" }),
      makeMessage({ id: "temp-123", role: "user", content: "optimistic" }),
    ];

    const merged = mergeMessagesWithLive(db, prev);

    expect(merged.map((m) => m.id)).toEqual(["db-1", "streaming-abc", "temp-123"]);
  });

  it("keeps a live turn above a message delivered into it mid-run", () => {
    // "Send now" on a queued message steers it into the agent: the live turn
    // started BEFORE it, so the snapshot (which holds the delivered message
    // and not yet the turn's own row) must not push it above the live bubble.
    const db = [
      makeMessage({ id: "db-prompt", createdAt: "2026-01-01T00:00:00.000Z" }),
      makeMessage({ id: "db-steered", createdAt: "2026-01-01T00:00:30.000Z" }),
    ];
    const prev = [
      makeMessage({ id: "db-prompt", createdAt: "2026-01-01T00:00:00.000Z" }),
      makeMessage({
        id: "streaming-turn-1",
        role: "assistant",
        content: "Working",
        createdAt: "2026-01-01T00:00:05.000Z",
      }),
    ];

    const merged = mergeMessagesWithLive(db, prev);

    expect(merged.map((m) => m.id)).toEqual(["db-prompt", "streaming-turn-1", "db-steered"]);
  });

  it("never sorts an optimistic message below the reply it follows", () => {
    // The optimistic copy carries the browser clock: a clock behind the
    // server's must not move the just-sent message above older messages.
    const db = [
      makeMessage({ id: "db-reply", role: "assistant", createdAt: "2030-01-01T00:00:00.000Z" }),
      makeMessage({
        id: "streaming-turn-2",
        role: "assistant",
        createdAt: "2030-01-01T00:00:01.000Z",
      }),
    ];
    const prev = [
      makeMessage({ id: "temp-1", role: "user", createdAt: "2026-01-01T00:00:00.000Z" }),
    ];

    const merged = mergeMessagesWithLive(db, prev);

    expect(merged.map((m) => m.id)).toEqual(["db-reply", "streaming-turn-2", "temp-1"]);
  });

  it("preserves the optimistic temp user message when the snapshot is stale", () => {
    // Stale snapshot: fetched BEFORE the POST /messages commit, so it lacks
    // the just-sent user message. The optimistic temp copy must survive,
    // otherwise the UI flashes back to the empty state.
    const staleDb: Message[] = [];
    const prev = [makeMessage({ id: "temp-123", role: "user", content: "hello" })];

    const merged = mergeMessagesWithLive(staleDb, prev);

    expect(merged.map((m) => m.id)).toEqual(["temp-123"]);
  });

  it("preserves streaming assistant messages on a stale snapshot", () => {
    const staleDb: Message[] = [];
    const prev = [
      makeMessage({ id: "db-user", role: "user", content: "hello" }),
      makeMessage({ id: "streaming-abc", role: "assistant", content: "gen..." }),
    ];

    const merged = mergeMessagesWithLive(staleDb, prev);

    // The saved user message is NOT re-added by a stale snapshot, but the
    // live streaming turn is kept.
    expect(merged.map((m) => m.id)).toEqual(["streaming-abc"]);
  });

  it("does not preserve non-user temp messages (compaction placeholder)", () => {
    const db = [makeMessage({ id: "compaction-1", role: "compaction", content: "summary" })];
    const prev = [makeMessage({ id: "temp-compaction-9", role: "compaction", content: "" })];

    const merged = mergeMessagesWithLive(db, prev);

    // The DB copy replaces the optimistic placeholder — no duplicate.
    expect(merged.map((m) => m.id)).toEqual(["compaction-1"]);
  });

  it("drops saved messages from prev — the DB snapshot wins", () => {
    const db = [makeMessage({ id: "db-1", content: "saved" })];
    const prev = [
      makeMessage({ id: "db-1", content: "saved" }),
      makeMessage({ id: "db-2", content: "older copy" }),
    ];

    const merged = mergeMessagesWithLive(db, prev);

    expect(merged.map((m) => m.id)).toEqual(["db-1"]);
  });

  it("handles empty prev and empty db", () => {
    expect(mergeMessagesWithLive([], [])).toEqual([]);
    expect(mergeMessagesWithLive([makeMessage({ id: "db-1" })], []).map((m) => m.id)).toEqual([
      "db-1",
    ]);
  });
});
