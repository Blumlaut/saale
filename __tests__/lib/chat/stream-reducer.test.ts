import { describe, it, expect, vi, afterEach } from "vitest";
import { streamReducer, type StreamAction, type StreamState } from "@/lib/chat/stream-reducer";
import type { Message } from "@/components/chat/types";

function state(messages: Message[] = [], rootMessageId: string | null = null): StreamState {
  return { messages, rootMessageId };
}

function msg(overrides: Partial<Message> & { id: string }): Message {
  return {
    role: "assistant",
    content: "",
    thinking: undefined,
    toolCalls: undefined,
    parentMessageId: undefined,
    createdAt: "2026-01-01T00:00:00.000Z",
    attachments: undefined,
    ...overrides,
  };
}

const empty = state();

afterEach(() => {
  vi.useRealTimers();
});

describe("streamReducer", () => {
  it("turn_start creates a streaming message", () => {
    const next = streamReducer(empty, { type: "turn_start", turnId: "t1" });
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]).toMatchObject({
      id: "streaming-t1",
      role: "assistant",
      content: "",
    });
  });

  it("turn_start adopts the server's turn start as the bubble's position", () => {
    const startedAt = "2026-01-01T00:00:42.000Z";
    const next = streamReducer(empty, { type: "turn_start", turnId: "t1", startedAt });

    expect(next.messages[0]!.createdAt).toBe(startedAt);
    // Re-delivered on reconnect: same position, not a fresh one.
    expect(
      streamReducer(next, { type: "turn_start", turnId: "t1", startedAt }).messages[0],
    ).toEqual(next.messages[0]);
  });

  it("turn_start without a server start falls back to the browser clock", () => {
    // A trimmed-buffer replay can create the bubble from a later event; there
    // is no server timestamp to adopt, so the browser's is the best guess.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:42.000Z"));
      const next = streamReducer(empty, { type: "turn_start", turnId: "t1" });
      expect(next.messages[0]!.createdAt).toBe("2026-01-01T00:00:42.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("token without a preceding turn_start creates the message (buffer replay)", () => {
    const next = streamReducer(empty, { type: "token", turnId: "t1", text: "hello" });
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]!.content).toBe("hello");
  });

  it("token updates the existing streaming message with cumulative text", () => {
    let s = streamReducer(empty, { type: "turn_start", turnId: "t1" });
    s = streamReducer(s, { type: "token", turnId: "t1", text: "hel" });
    s = streamReducer(s, { type: "token", turnId: "t1", text: "hello" });
    expect(s.messages[0]!.content).toBe("hello");
    expect(s.messages).toHaveLength(1);
  });

  it("empty thinking opens the block without clearing reasoning", () => {
    let s = streamReducer(empty, { type: "thinking", turnId: "t1", thinking: "" });
    // The bubble still appears: an empty event is the block opening.
    expect(s.messages).toHaveLength(1);
    s = streamReducer(s, { type: "thinking", turnId: "t1", thinking: "hmm" });
    expect(s.messages[0]!.thinking).toBe("hmm");
    // A later empty event only means "no reasoning yet"  it must not wipe what
    // is on screen (for a saved row that would take a reload to bring back).
    s = streamReducer(s, { type: "thinking", turnId: "t1", thinking: "" });
    expect(s.messages[0]!.thinking).toBe("hmm");
  });

  it("tool_pending shows a call whose arguments the model is still writing", () => {
    // Pi announces the call and streams its arguments long before execution;
    // the card has to exist in that gap, with the arguments it has so far.
    let s = streamReducer(empty, {
      type: "tool_pending",
      turnId: "t1",
      toolCallId: "call-1",
      toolName: "bash",
      args: {},
    });
    expect(s.messages[0]!.toolCalls).toEqual([
      { id: "call-1", name: "bash", args: {}, status: "pending" },
    ]);

    // Later deltas replace the arguments in place: one card, not one per delta.
    s = streamReducer(s, {
      type: "tool_pending",
      turnId: "t1",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "git sta" },
    });
    expect(s.messages[0]!.toolCalls).toHaveLength(1);
    expect(s.messages[0]!.toolCalls![0]!.args).toEqual({ command: "git sta" });
  });

  it("tool_start turns a pending call into a running one with its final arguments", () => {
    let s = streamReducer(empty, {
      type: "tool_pending",
      turnId: "t1",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "git stat" },
    });
    s = streamReducer(s, {
      type: "tool_start",
      turnId: "t1",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "git status" },
    });

    expect(s.messages[0]!.toolCalls).toHaveLength(1);
    expect(s.messages[0]!.toolCalls![0]).toMatchObject({
      status: "running",
      args: { command: "git status" },
    });
  });

  it("a replayed tool_pending never overwrites a call that is already running", () => {
    // The buffer replays the whole generation on reconnect, so an old partial
    // argument object can arrive after execution started.
    let s = streamReducer(empty, {
      type: "tool_start",
      turnId: "t1",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "git status" },
    });
    s = streamReducer(s, {
      type: "tool_pending",
      turnId: "t1",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "git sta" },
    });

    expect(s.messages[0]!.toolCalls![0]).toMatchObject({
      status: "running",
      args: { command: "git status" },
    });
  });

  it("tool_start adds a running tool call and dedupes re-delivered calls", () => {
    const action = {
      type: "tool_start" as const,
      turnId: "t1",
      toolCallId: "call-1",
      toolName: "web_search",
      args: { query: "x" },
    };
    let s = streamReducer(empty, { type: "turn_start", turnId: "t1" });
    s = streamReducer(s, action);
    expect(s.messages[0]!.toolCalls).toEqual([
      { id: "call-1", name: "web_search", args: { query: "x" }, status: "running" },
    ]);
    // Re-delivery (reconnect replay) must not duplicate.
    const again = streamReducer(s, action);
    expect(again.messages[0]!.toolCalls).toHaveLength(1);
  });

  it("tool_start without a turn message creates one seeded with the tool call", () => {
    const next = streamReducer(empty, {
      type: "tool_start",
      turnId: "t1",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "ls" },
    });
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]!.toolCalls).toHaveLength(1);
  });

  it("tool_update streams partial output into a running tool call", () => {
    let s = streamReducer(empty, {
      type: "tool_start",
      turnId: "t1",
      toolCallId: "call-1",
      toolName: "bash",
      args: {},
    });
    s = streamReducer(s, {
      type: "tool_update",
      turnId: "t1",
      toolCallId: "call-1",
      partialResult: "out",
    });
    expect(s.messages[0]!.toolCalls![0]!.result).toBe("out");
  });

  it("tool_end marks the call completed with its result", () => {
    let s = streamReducer(empty, {
      type: "tool_start",
      turnId: "t1",
      toolCallId: "call-1",
      toolName: "bash",
      args: {},
    });
    s = streamReducer(s, { type: "tool_end", turnId: "t1", toolCallId: "call-1", result: "done" });
    const tc = s.messages[0]!.toolCalls![0]!;
    expect(tc.status).toBe("completed");
    expect(tc.result).toBe("done");
    expect(tc.error).toBeUndefined();
  });

  it("tool_end with isError marks the call as error", () => {
    let s = streamReducer(empty, {
      type: "tool_start",
      turnId: "t1",
      toolCallId: "call-1",
      toolName: "bash",
      args: {},
    });
    s = streamReducer(s, {
      type: "tool_end",
      turnId: "t1",
      toolCallId: "call-1",
      result: "boom",
      isError: true,
    });
    const tc = s.messages[0]!.toolCalls![0]!;
    expect(tc.status).toBe("error");
    expect(tc.error).toBe("boom");
  });

  it("turn_end finalizes content and thinking (safety net for the final token)", () => {
    let s = streamReducer(empty, { type: "turn_start", turnId: "t1" });
    s = streamReducer(s, { type: "turn_end", turnId: "t1", text: "final", thinking: "thought" });
    expect(s.messages[0]!.content).toBe("final");
    expect(s.messages[0]!.thinking).toBe("thought");
  });

  it("turn_discarded drops the retried turn's bubble", () => {
    let s = streamReducer(empty, { type: "turn_start", turnId: "t1" });
    s = streamReducer(s, { type: "token", turnId: "t1", text: "half an answer" });
    s = streamReducer(s, { type: "turn_discarded", turnId: "t1", messageId: null });
    expect(s.messages).toHaveLength(0);
  });

  it("turn_discarded clears the root when the discarded message was the root", () => {
    let s = streamReducer(empty, { type: "turn_start", turnId: "t1" });
    s = streamReducer(s, { type: "message_saved", turnId: "t1", messageId: "root-1" });
    s = streamReducer(s, { type: "turn_discarded", turnId: "t1", messageId: "root-1" });
    expect(s.rootMessageId).toBeNull();
    // The retried turn must not be grouped under the deleted message.
    s = streamReducer(s, { type: "turn_start", turnId: "t2" });
    expect(s.messages[0]!.parentMessageId).toBeUndefined();
  });

  it("turn_discarded keeps the root when an earlier turn survived", () => {
    let s = streamReducer(empty, { type: "turn_start", turnId: "t1" });
    s = streamReducer(s, { type: "message_saved", turnId: "t1", messageId: "root-1" });
    s = streamReducer(s, { type: "turn_start", turnId: "t2" });
    s = streamReducer(s, { type: "message_saved", turnId: "t2", messageId: "child-2" });
    s = streamReducer(s, { type: "turn_discarded", turnId: "t2", messageId: "child-2" });
    expect(s.rootMessageId).toBe("root-1");
    expect(s.messages.map((m) => m.id)).toEqual(["root-1"]);
  });

  it("message_saved swaps the streaming ID for the real DB ID", () => {
    let s = streamReducer(empty, { type: "turn_start", turnId: "t1" });
    s = streamReducer(s, { type: "message_saved", turnId: "t1", messageId: "msg-1" });
    expect(s.messages[0]!.id).toBe("msg-1");
    expect(s.rootMessageId).toBe("msg-1");
  });

  it("first saved message becomes the root; later turns inherit it as parent", () => {
    let s = streamReducer(empty, { type: "turn_start", turnId: "t1" });
    s = streamReducer(s, { type: "message_saved", turnId: "t1", messageId: "root-1" });
    // Child turn of the same generation streams in.
    s = streamReducer(s, { type: "turn_start", turnId: "t2" });
    expect(s.messages[1]!.parentMessageId).toBe("root-1");
    // A second message_saved must NOT change the root.
    s = streamReducer(s, { type: "message_saved", turnId: "t2", messageId: "child-2" });
    expect(s.rootMessageId).toBe("root-1");
  });

  it("generation_done drops streaming messages but keeps saved ones", () => {
    let s = streamReducer(empty, { type: "turn_start", turnId: "t1" });
    s = streamReducer(s, { type: "message_saved", turnId: "t1", messageId: "saved-1" });
    s = streamReducer(s, { type: "turn_start", turnId: "t2" });
    s = streamReducer(s, { type: "generation_done" });
    expect(s.messages.map((m) => m.id)).toEqual(["saved-1"]);
  });

  it("leaves unrelated messages untouched", () => {
    const base = state([msg({ id: "saved-user", role: "user", content: "hi" })]);
    const next = streamReducer(base, { type: "turn_start", turnId: "t1" });
    expect(next.messages).toHaveLength(2);
    expect(next.messages[0]).toBe(base.messages[0]);
  });
});

/**
 * A mid-run reconnect replays the session buffer, so turns the client already
 * has are delivered again. `message_saved` renames a turn's bubble to its DB
 * row, which is what made those replayed events unrecognisable  they were
 * applied to a message that no longer existed, creating a second copy of a step
 * the user was already looking at.
 */
describe("streamReducer  replay after a turn is saved", () => {
  /** One step: thinking, its tool call, its text, then its DB row. */
  const step = (n: number): StreamAction[] => [
    { type: "turn_start", turnId: `t${n}`, startedAt: `2026-01-01T00:00:0${n}.000Z` },
    { type: "thinking", turnId: `t${n}`, thinking: `step ${n} reasoning` },
    { type: "tool_start", turnId: `t${n}`, toolCallId: `tc${n}`, toolName: "bash", args: {} },
    { type: "tool_end", turnId: `t${n}`, toolCallId: `tc${n}`, result: "ok" },
    { type: "turn_end", turnId: `t${n}`, text: `step ${n} answer` },
    { type: "message_saved", turnId: `t${n}`, messageId: `a${n}` },
  ];
  const run = (from: StreamState, actions: StreamAction[]) =>
    actions.reduce((s, a) => streamReducer(s, a), from);

  /** Client mid-run: two steps saved, the third still streaming. */
  const midRun = () =>
    run(empty, [
      ...step(1),
      ...step(2),
      ...step(3).slice(0, 3),
      { type: "token", turnId: "t3", text: "ste" },
    ]);

  it("keeps one copy of each step when the whole buffer is replayed", () => {
    const live = midRun();
    expect(live.messages.map((m) => m.id)).toEqual(["a1", "a2", "streaming-t3"]);

    // No Last-Event-ID: every event since the run began arrives again.
    const replayed = run(live, [...step(1), ...step(2)]);

    expect(replayed.messages.map((m) => m.id)).toEqual(["a1", "a2", "streaming-t3"]);
    const ids = replayed.messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(replayed.messages.map((m) => m.thinking)).toEqual([
      "step 1 reasoning",
      "step 2 reasoning",
      "step 3 reasoning",
    ]);
    expect(replayed.messages.map((m) => m.toolCalls?.length)).toEqual([1, 1, 1]);
  });

  it("replays the run without mutating it (replay is idempotent)", () => {
    const live = midRun();
    const once = run(live, [...step(1), ...step(2)]);
    const twice = run(once, [...step(1), ...step(2)]);
    expect(twice.messages).toEqual(once.messages);
  });

  it("updates the saved message when the buffer was trimmed past its save", () => {
    // The 500-event buffer drops a prefix, so a turn's events can arrive
    // without the `message_saved` that renamed its bubble.
    const live = midRun();
    const replayed = run(live, [
      { type: "thinking", turnId: "t2", thinking: "step 2 reasoning" },
      { type: "tool_start", turnId: "t2", toolCallId: "tc2", toolName: "bash", args: {} },
      { type: "tool_end", turnId: "t2", toolCallId: "tc2", result: "ok" },
      { type: "turn_end", turnId: "t2", text: "step 2 answer" },
    ]);

    expect(replayed.messages.map((m) => m.id)).toEqual(["a1", "a2", "streaming-t3"]);
    expect(replayed.messages[1]).toMatchObject({
      id: "a2",
      thinking: "step 2 reasoning",
      content: "step 2 answer",
    });
    expect(replayed.messages[1]!.toolCalls?.map((tc) => tc.status)).toEqual(["completed"]);
  });

  it("drops the live bubble when the row is already on screen", () => {
    // Replayed `turn_end` re-created the bubble, then its `message_saved`
    // arrived while the DB row was loaded by a mid-run reload.
    let s = streamReducer(empty, { type: "turn_start", turnId: "t1" });
    s = streamReducer(s, {
      type: "turn_end",
      turnId: "t1",
      text: "answer",
      thinking: "reasoning",
    });
    s = state(
      [...s.messages, msg({ id: "a1", role: "assistant", content: "answer" })],
      s.rootMessageId,
    );
    s = streamReducer(s, { type: "message_saved", turnId: "t1", messageId: "a1" });

    expect(s.messages.map((m) => m.id)).toEqual(["a1"]);
  });

  it("ignores a re-delivered message_saved for an already renamed turn", () => {
    let s = streamReducer(empty, { type: "turn_start", turnId: "t1" });
    s = streamReducer(s, { type: "message_saved", turnId: "t1", messageId: "a1" });
    s = streamReducer(s, { type: "message_saved", turnId: "t1", messageId: "a1" });
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]!.id).toBe("a1");
  });

  it("applies a late tool_end to the saved row instead of a new bubble", () => {
    let s = streamReducer(empty, { type: "turn_start", turnId: "t1" });
    s = streamReducer(s, {
      type: "tool_start",
      turnId: "t1",
      toolCallId: "tc1",
      toolName: "bash",
      args: { cmd: "ls" },
    });
    s = streamReducer(s, { type: "message_saved", turnId: "t1", messageId: "a1" });
    s = streamReducer(s, { type: "tool_end", turnId: "t1", toolCallId: "tc1", result: "done" });

    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({ id: "a1" });
    expect(s.messages[0]!.toolCalls?.[0]).toMatchObject({ status: "completed", result: "done" });
  });

  it("moves a folded turn's content onto the row it was saved into", () => {
    // `agent_end` finalizes a run by UPDATING an existing row, and a reload can
    // deliver that row while its turn is still streaming. The row is on screen
    // under the turn's id, so the newest text belongs on it  dropping the
    // bubble's content would blank the step until the next reload.
    let s = state([msg({ id: "a1", role: "assistant", content: "first answer" })], "a1");
    s = streamReducer(s, { type: "turn_start", turnId: "t2" });
    s = streamReducer(s, { type: "thinking", turnId: "t2", thinking: "final reasoning" });
    s = streamReducer(s, { type: "token", turnId: "t2", text: "final answer" });
    s = streamReducer(s, { type: "message_saved", turnId: "t2", messageId: "a1" });

    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({
      id: "a1",
      content: "final answer",
      thinking: "final reasoning",
      // The row speaks for the turn now, so its later events land on it.
      turnId: "t2",
    });
  });

  it("keeps the row's own tag when it already has one", () => {
    let s = state([msg({ id: "a1", role: "assistant", content: "first", turnId: "t1" })], "a1");
    s = streamReducer(s, { type: "turn_start", turnId: "t2" });
    s = streamReducer(s, { type: "token", turnId: "t2", text: "second" });
    s = streamReducer(s, { type: "message_saved", turnId: "t2", messageId: "a1" });

    expect(s.messages[0]).toMatchObject({ id: "a1", content: "second", turnId: "t1" });
  });

  it("stamps a saved turn with the moment the client learned its id", () => {
    let s = streamReducer(empty, { type: "turn_start", turnId: "t1" });
    s = streamReducer(s, {
      type: "message_saved",
      turnId: "t1",
      messageId: "a1",
      receivedAt: 1_700_000_000_000,
    });
    expect(s.messages[0]!.savedAt).toBe(1_700_000_000_000);
  });

  it("turn_discarded drops a turn already swapped for its row", () => {
    // `messageId` is null when the discard raced the save, so the turn tag has
    // to identify the bubble.
    let s = streamReducer(empty, { type: "turn_start", turnId: "t1" });
    s = streamReducer(s, { type: "message_saved", turnId: "t1", messageId: "a1" });
    s = streamReducer(s, { type: "turn_discarded", turnId: "t1", messageId: null });
    expect(s.messages).toEqual([]);
    expect(s.rootMessageId).toBeNull();
  });
});
