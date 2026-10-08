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

  it("carries the live turn's tag onto its saved row", () => {
    // The tag is how the reducer knows a replayed event belongs to a message
    // it already has; losing it on reload would let a replay add a copy.
    const db = [makeMessage({ id: "db-1", role: "assistant", content: "saved" })];
    const prev = [makeMessage({ id: "db-1", role: "assistant", turnId: "turn-1" })];

    const merged = mergeMessagesWithLive(db, prev);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.turnId).toBe("turn-1");
    expect(merged[0]!.content).toBe("saved");
  });

  it("leaves rows without a live counterpart untagged", () => {
    const db = [makeMessage({ id: "db-1" }), makeMessage({ id: "db-2", role: "assistant" })];
    const prev = [makeMessage({ id: "db-1", turnId: "turn-1" })];

    const merged = mergeMessagesWithLive(db, prev);

    expect(merged.map((m) => m.turnId)).toEqual(["turn-1", undefined]);
  });

  it("keeps a turn saved while the snapshot was in flight", () => {
    // The snapshot was read before the save committed, but `message_saved`
    // renamed the bubble before the response landed. The row is on screen and
    // in the DB, so keeping it is right — and its absence from the snapshot is
    // explained by the save's timing, not by a delete.
    const staleDb = [makeMessage({ id: "db-user", role: "user", content: "hi" })];
    const prev = [
      makeMessage({ id: "db-user", role: "user", content: "hi" }),
      makeMessage({ id: "db-turn-1", role: "assistant", content: "saved", savedAt: 5_000 }),
    ];

    const merged = mergeMessagesWithLive(staleDb, prev, { requestedAt: 4_000 });

    expect(merged.map((m) => m.id)).toEqual(["db-user", "db-turn-1"]);
  });

  it("drops a message the snapshot lacks when the save predates the request", () => {
    // Saved before the request, so a snapshot without it means it is gone from
    // the DB — deleted, or truncated by editing an earlier message. Keeping it
    // would make those actions look like they did nothing.
    const db = [makeMessage({ id: "db-user", role: "user", content: "edited" })];
    const prev = [
      makeMessage({ id: "db-user", role: "user", content: "original" }),
      makeMessage({ id: "db-gone", role: "assistant", content: "truncated", savedAt: 3_000 }),
    ];

    const merged = mergeMessagesWithLive(db, prev, { requestedAt: 4_000 });

    expect(merged.map((m) => m.id)).toEqual(["db-user"]);
  });

  it("drops an untagged message the snapshot lacks", () => {
    // Loaded from the DB by an earlier snapshot, never streamed here: the tag
    // is what marks it as this client's own turn.
    const db = [makeMessage({ id: "db-user", role: "user" })];
    const prev = [makeMessage({ id: "db-user", role: "user" }), makeMessage({ id: "db-gone" })];

    const merged = mergeMessagesWithLive(db, prev, { requestedAt: 4_000 });

    expect(merged.map((m) => m.id)).toEqual(["db-user"]);
  });

  it("prefers the snapshot's copy of a row it does contain", () => {
    const db = [makeMessage({ id: "db-1", role: "assistant", content: "from the DB" })];
    const prev = [
      makeMessage({ id: "db-1", role: "assistant", content: "streamed", savedAt: 5_000 }),
    ];

    const merged = mergeMessagesWithLive(db, prev, { requestedAt: 4_000 });

    expect(merged).toHaveLength(1);
    expect(merged[0]!.content).toBe("from the DB");
  });

  it("keeps nothing when the caller does not say when it asked", () => {
    // Without a request time there is no way to tell a stale snapshot from a
    // deletion, so the snapshot wins.
    const db = [makeMessage({ id: "db-user", role: "user" })];
    const prev = [
      makeMessage({ id: "db-user", role: "user" }),
      makeMessage({ id: "db-1", role: "assistant", savedAt: 5_000 }),
    ];

    expect(mergeMessagesWithLive(db, prev).map((m) => m.id)).toEqual(["db-user"]);
  });
});
