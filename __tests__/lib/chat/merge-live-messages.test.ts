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
