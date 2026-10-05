import { describe, it, expect, vi, beforeEach } from "vitest";
import { ACTIVE_SESSION_HEARTBEAT_MS, ACTIVE_SESSION_TTL_SECONDS } from "@/lib/redis";

// ─── Mocks ─────────────────────────────────────────────────────────────────

const mockSaveAssistantMessage = vi.fn();
vi.mock("@/lib/pi/stream-helpers", () => ({
  saveAssistantMessage: (...args: unknown[]) => mockSaveAssistantMessage(...args),
}));

const mockPublishSessionEvent = vi.fn();
const mockResetSessionEvents = vi.fn();
vi.mock("@/lib/pi/session-events", () => ({
  publishSessionEvent: (...args: unknown[]) => mockPublishSessionEvent(...args),
  resetSessionEvents: (...args: unknown[]) => mockResetSessionEvents(...args),
}));

const mockRegisterActiveSession = vi.fn();
const mockUnregisterActiveSession = vi.fn();
vi.mock("@/lib/redis", async () => {
  // The heartbeat cadence is the real module's contract (see redis.ts); only
  // the Redis calls are stubbed.
  const actual = await vi.importActual<typeof import("@/lib/redis")>("@/lib/redis");
  return {
    ACTIVE_SESSION_HEARTBEAT_MS: actual.ACTIVE_SESSION_HEARTBEAT_MS,
    ACTIVE_SESSION_TTL_SECONDS: actual.ACTIVE_SESSION_TTL_SECONDS,
    registerActiveSession: (...args: unknown[]) => mockRegisterActiveSession(...args),
    unregisterActiveSession: (...args: unknown[]) => mockUnregisterActiveSession(...args),
  };
});

const mockChatSessionUpdate = vi.fn();
const mockChatMessageDeleteMany = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    chatSession: {
      update: (...args: unknown[]) => mockChatSessionUpdate(...args),
    },
    chatMessage: {
      deleteMany: (...args: unknown[]) => mockChatMessageDeleteMany(...args),
    },
  },
}));

const mockSaveCompactionMessage = vi.fn();
vi.mock("@/lib/chat/compaction", () => ({
  saveCompactionMessage: (...args: unknown[]) => mockSaveCompactionMessage(...args),
}));

import { createSessionEventTracker } from "@/lib/pi/session-event-tracker";
import { requestSessionAbort, wasSessionAbortRequested } from "@/lib/pi/abort-request";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

// ─── Helpers ────────────────────────────────────────────────────────────────

interface FakeAgentEvent {
  type: string;
  [key: string]: unknown;
}

function createFakeSession(
  options: {
    contextTokens?: number | null;
    contextWindow?: number;
  } = {},
) {
  const listeners = new Set<(event: FakeAgentEvent) => void>();
  const contextWindow = options.contextWindow ?? 100_000;
  return {
    subscribe: (listener: (event: FakeAgentEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (event: FakeAgentEvent) => {
      for (const listener of [...listeners]) listener(event);
    },
    model: { contextWindow },
    compact: vi.fn().mockResolvedValue({ tokensBefore: 50 }),
    // Pi's own context accounting — the tracker must publish this, not a sum
    // of per-message usage.
    getContextUsage: () => ({
      tokens: options.contextTokens === undefined ? 42_000 : options.contextTokens,
      contextWindow,
      percent:
        options.contextTokens === null
          ? null
          : ((options.contextTokens ?? 42_000) / contextWindow) * 100,
    }),
  } as unknown as AgentSession & { emit: (event: FakeAgentEvent) => void };
}

/** Let pending promise chains (DB saves → publishes) settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

interface PublishedEvent {
  event: string;
  data: Record<string, unknown>;
}

function setup() {
  const published: PublishedEvent[] = [];
  mockPublishSessionEvent.mockImplementation((_sessionId: string, event: string, data: unknown) => {
    published.push({ event, data: data as Record<string, unknown> });
    return Promise.resolve(published.length);
  });
  mockResetSessionEvents.mockResolvedValue(undefined);
  mockRegisterActiveSession.mockResolvedValue(undefined);
  mockUnregisterActiveSession.mockResolvedValue(undefined);
  mockChatSessionUpdate.mockResolvedValue({});
  mockChatMessageDeleteMany.mockResolvedValue({ count: 1 });
  mockSaveCompactionMessage.mockResolvedValue(undefined);
  return { published };
}

/**
 * Emit a full single-turn run up to (but not including) agent_settled.
 */
function emitRun(session: ReturnType<typeof createFakeSession>, text: string = "Hello"): void {
  session.emit({ type: "agent_start" });
  session.emit({
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
  session.emit({
    type: "turn_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
    toolResults: [],
  });
  session.emit({
    type: "agent_end",
    messages: [{ role: "assistant", content: [{ type: "text", text }] }],
  });
}

describe("createSessionEventTracker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("publishes the full turn lifecycle and saves to DB", async () => {
    const { published } = setup();
    let savedCounter = 0;
    mockSaveAssistantMessage.mockImplementation(() => {
      savedCounter++;
      return Promise.resolve({ id: `msg-${savedCounter}` });
    });

    const session = createFakeSession();
    createSessionEventTracker({ sessionId: "s1", userId: "u1", session });

    session.emit({ type: "agent_start" });
    session.emit({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "Hello world" }] },
    });
    session.emit({
      type: "turn_end",
      message: { role: "assistant", content: [{ type: "text", text: "Hello world" }] },
      toolResults: [],
    });
    session.emit({
      type: "agent_end",
      messages: [{ role: "assistant", content: [{ type: "text", text: "Hello world" }] }],
    });
    session.emit({ type: "agent_settled" });

    await flush();
    await flush();

    const events = published.map((p) => p.event);
    expect(events).toContain("turn_start");
    expect(events).toContain("token");
    expect(events).toContain("turn_end");
    expect(events).toContain("message_saved");
    expect(events).toContain("done");

    // The token event carries cumulative text + a turnId.
    const token = published.find((p) => p.event === "token")!;
    expect(token.data.text).toBe("Hello world");
    expect(typeof token.data.turnId).toBe("string");

    // message_saved pairs the same turnId with the DB message id.
    const turnId = token.data.turnId;
    const saved = published.find((p) => p.event === "message_saved")!;
    expect(saved.data.turnId).toBe(turnId);
    expect(saved.data.messageId).toBe("msg-1");

    // turn_end references the same turn.
    const turnEnd = published.find((p) => p.event === "turn_end")!;
    expect(turnEnd.data.turnId).toBe(turnId);

    // The assistant message was persisted with the streamed content.
    expect(mockSaveAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s1",
        content: "Hello world",
        parentMessageId: null,
      }),
    );
  });

  it("clears the event buffer at the start of a run", async () => {
    setup();
    mockSaveAssistantMessage.mockResolvedValue({ id: "msg-1" });

    const session = createFakeSession();
    createSessionEventTracker({ sessionId: "s1", userId: "u1", session });

    session.emit({ type: "agent_start" });

    expect(mockResetSessionEvents).toHaveBeenCalledWith("s1");
  });

  it("forwards tool_execution_update as tool_update, throttled per tool call", async () => {
    vi.useFakeTimers();
    try {
      const { published } = setup();
      mockSaveAssistantMessage.mockResolvedValue({ id: "msg-1" });

      const session = createFakeSession();
      createSessionEventTracker({ sessionId: "s1", userId: "u1", session });

      session.emit({
        type: "tool_execution_start",
        toolCallId: "tc-1",
        toolName: "bash",
        args: { command: "sleep 300" },
      });
      // Pi's bash tool streams output at ~100ms; the tracker must forward it
      // (normalized to text) but throttle to ~1/s so the buffer isn't flooded.
      session.emit({
        type: "tool_execution_update",
        toolCallId: "tc-1",
        toolName: "bash",
        args: { command: "sleep 300" },
        partialResult: { content: [{ type: "text", text: "chunk-1" }] },
      });
      session.emit({
        type: "tool_execution_update",
        toolCallId: "tc-1",
        toolName: "bash",
        args: { command: "sleep 300" },
        partialResult: { content: [{ type: "text", text: "chunk-2" }] },
      });

      let updates = published.filter((p) => p.event === "tool_update");
      expect(updates).toHaveLength(1);
      expect(updates[0]!.data.partialResult).toBe("chunk-1");
      expect(updates[0]!.data.toolCallId).toBe("tc-1");
      expect(typeof updates[0]!.data.turnId).toBe("string");

      // After the throttle window, the next update is forwarded again.
      vi.advanceTimersByTime(1001);
      session.emit({
        type: "tool_execution_update",
        toolCallId: "tc-1",
        toolName: "bash",
        args: { command: "sleep 300" },
        partialResult: { content: [{ type: "text", text: "chunk-3" }] },
      });

      updates = published.filter((p) => p.event === "tool_update");
      expect(updates).toHaveLength(2);
      expect(updates[1]!.data.partialResult).toBe("chunk-3");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the active-session flag fresh while Pi is streaming (no drift)", async () => {
    vi.useFakeTimers();
    try {
      setup();
      mockSaveAssistantMessage.mockResolvedValue({ id: "msg-1" });

      const session = createFakeSession();
      (session as unknown as { isStreaming: boolean }).isStreaming = true;
      createSessionEventTracker({ sessionId: "s1", userId: "u1", session });

      session.emit({ type: "agent_start" });
      // The caller (POST /messages or the Telegram processor) registers the
      // flag before prompting; the tracker's heartbeat only keeps it fresh.
      expect(mockRegisterActiveSession).not.toHaveBeenCalled();

      // A long silent tool call emits no events; the heartbeat (driven by
      // Pi's session.isStreaming) must keep refreshing the flag, several times
      // inside the liveness TTL so a live run can never look dead.
      const beats = Math.floor(
        (ACTIVE_SESSION_TTL_SECONDS * 1000 - 1) / ACTIVE_SESSION_HEARTBEAT_MS,
      );
      expect(beats).toBeGreaterThanOrEqual(2);
      vi.advanceTimersByTime(ACTIVE_SESSION_HEARTBEAT_MS * (beats + 1));
      expect(mockRegisterActiveSession).toHaveBeenCalledWith("u1", "s1");
      expect(mockRegisterActiveSession).toHaveBeenCalledTimes(beats + 1);

      // Once Pi actually stops streaming, the flag stops being refreshed.
      (session as unknown as { isStreaming: boolean }).isStreaming = false;
      vi.advanceTimersByTime(ACTIVE_SESSION_HEARTBEAT_MS * 6);
      expect(mockRegisterActiveSession).toHaveBeenCalledTimes(beats + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits tool_start / tool_end with the turnId", async () => {
    const { published } = setup();
    mockSaveAssistantMessage.mockResolvedValue({ id: "msg-1" });

    const session = createFakeSession();
    createSessionEventTracker({ sessionId: "s1", userId: "u1", session });

    session.emit({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc-1", name: "search", arguments: { q: "x" } }],
      },
    });
    session.emit({
      type: "tool_execution_start",
      toolCallId: "tc-1",
      toolName: "search",
      args: { q: "x" },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "tc-1",
      toolName: "search",
      result: "found",
      isError: false,
    });

    const toolStart = published.find((p) => p.event === "tool_start")!;
    expect(toolStart.data).toMatchObject({
      toolCallId: "tc-1",
      toolName: "search",
      args: { q: "x" },
    });
    expect(typeof toolStart.data.turnId).toBe("string");

    const toolEnd = published.find((p) => p.event === "tool_end")!;
    expect(toolEnd.data.turnId).toBe(toolStart.data.turnId);
    expect(toolEnd.data.result).toBe("found");
    expect(toolEnd.data.isError).toBe(false);
  });

  it("assigns distinct turnIds across turns (no collisions)", async () => {
    const { published } = setup();
    mockSaveAssistantMessage.mockResolvedValue({ id: "msg-1" });

    const session = createFakeSession();
    createSessionEventTracker({ sessionId: "s1", userId: "u1", session });

    session.emit({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "First" }] },
    });
    session.emit({
      type: "turn_end",
      message: { role: "assistant", content: [{ type: "text", text: "First" }] },
      toolResults: [],
    });
    session.emit({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "Second" }] },
    });
    session.emit({
      type: "turn_end",
      message: { role: "assistant", content: [{ type: "text", text: "Second" }] },
      toolResults: [],
    });

    const turnStarts = published.filter((p) => p.event === "turn_start");
    expect(turnStarts).toHaveLength(2);
    expect(turnStarts[0]!.data.turnId).not.toBe(turnStarts[1]!.data.turnId);
  });

  it("keys a turn's live bubble and its saved row to the same start", async () => {
    // The live bubble and the row it becomes must agree on where the turn
    // sits in the conversation, otherwise a message delivered into the run
    // mid-turn sorts above the live bubble and then above the saved row (or
    // vice versa) — the "send now jumps up one message" bug.
    const { published } = setup();
    mockSaveAssistantMessage.mockResolvedValue({ id: "msg-1" });

    const session = createFakeSession();
    createSessionEventTracker({ sessionId: "s1", userId: "u1", session });

    session.emit({ type: "agent_start" });
    const before = Date.now();
    session.emit({ type: "turn_start" });
    const after = Date.now();
    session.emit({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "Working" }] },
    });
    // The row is only written when the turn ends — long after it began.
    await new Promise((resolve) => setTimeout(resolve, 20));
    session.emit({
      type: "turn_end",
      message: { role: "assistant", content: [{ type: "text", text: "Working" }] },
      toolResults: [],
    });

    const announced = published.find((p) => p.event === "turn_start")!;
    const startedAt = announced.data.startedAt as string;
    expect(Date.parse(startedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(startedAt)).toBeLessThanOrEqual(after);

    const saved = mockSaveAssistantMessage.mock.calls[0]![0] as { createdAt: Date };
    expect(saved.createdAt.toISOString()).toBe(startedAt);
    expect(saved.createdAt.getTime()).toBeLessThan(Date.now());
  });

  it("orders the turns of a run by when each one began", async () => {
    const { published } = setup();
    let saved = 0;
    mockSaveAssistantMessage.mockImplementation(() => Promise.resolve({ id: `msg-${++saved}` }));

    const session = createFakeSession();
    createSessionEventTracker({ sessionId: "s1", userId: "u1", session });

    for (const text of ["First", "Second"]) {
      session.emit({ type: "turn_start" });
      session.emit({
        type: "message_update",
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      session.emit({
        type: "turn_end",
        message: { role: "assistant", content: [{ type: "text", text }] },
        toolResults: [],
      });
    }

    const [first, second] = mockSaveAssistantMessage.mock.calls.map(
      (call) => (call[0] as { createdAt: Date }).createdAt,
    );
    expect(first!.getTime()).toBeLessThan(second!.getTime());

    const declared = published.filter((p) => p.event === "turn_start");
    expect(Date.parse(declared[0]!.data.startedAt as string)).toBe(first!.getTime());
    expect(Date.parse(declared[1]!.data.startedAt as string)).toBe(second!.getTime());
  });

  it("finalizes the last message at agent_end (updates existing turn message)", async () => {
    setup();
    mockSaveAssistantMessage.mockResolvedValue({ id: "msg-1" });

    const session = createFakeSession();
    createSessionEventTracker({ sessionId: "s1", userId: "u1", session });

    session.emit({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "Final" }] },
    });
    session.emit({
      type: "turn_end",
      message: { role: "assistant", content: [{ type: "text", text: "Final" }] },
      toolResults: [],
    });
    session.emit({
      type: "agent_end",
      messages: [{ role: "assistant", content: [{ type: "text", text: "Final" }] }],
    });

    await flush();
    await flush();

    // The agent_end finalize re-saves with the existing message id.
    const finalCall = mockSaveAssistantMessage.mock.calls.at(-1)![0] as { messageId?: string };
    expect(finalCall.messageId).toBe("msg-1");
  });

  it("defers done, unregister, and message count to agent_settled (not agent_end)", async () => {
    const { published } = setup();
    mockSaveAssistantMessage.mockResolvedValue({ id: "msg-1" });

    const session = createFakeSession();
    createSessionEventTracker({ sessionId: "s1", userId: "u1", session });

    emitRun(session, "Hi");

    await flush();
    await flush();

    // agent_end is NOT terminal: the SDK may still compact/retry/continue.
    expect(published.map((p) => p.event)).not.toContain("done");
    expect(mockUnregisterActiveSession).not.toHaveBeenCalled();

    session.emit({ type: "agent_settled" });

    await flush();
    await flush();

    expect(published.map((p) => p.event)).toContain("done");
    expect(mockUnregisterActiveSession).toHaveBeenCalledWith("u1", "s1");
    expect(mockChatSessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "s1" },
        data: { messageCount: { increment: 1 }, lastActivityAt: expect.any(Date) },
      }),
    );
  });

  it("advances lastActivityAt on assistant output but NOT on tool state changes", async () => {
    setup();
    mockSaveAssistantMessage.mockResolvedValue({ id: "msg-1" });

    const session = createFakeSession();
    createSessionEventTracker({ sessionId: "s1", userId: "u1", session });

    // A tool call persists active-tool state — it must NOT advance
    // lastActivityAt (that would move the chat to the top of the list
    // without any real message activity).
    session.emit({
      type: "tool_execution_start",
      toolCallId: "tc-1",
      toolName: "bash",
      args: { command: "ls" },
    });
    session.emit({
      type: "tool_execution_end",
      toolCallId: "tc-1",
      toolName: "bash",
      result: "ok",
      isError: false,
    });

    const toolUpdates = mockChatSessionUpdate.mock.calls.filter(
      (call) => (call[0] as { data: Record<string, unknown> }).data.activeToolName !== undefined,
    );
    expect(toolUpdates.length).toBeGreaterThan(0);
    for (const call of toolUpdates) {
      const data = (call[0] as { data: Record<string, unknown> }).data;
      expect(data).not.toHaveProperty("lastActivityAt");
    }

    // Assistant output (settled run) is real activity — it must advance it.
    emitRun(session, "Hi");
    session.emit({ type: "agent_settled" });

    await flush();
    await flush();

    const agentEndUpdate = mockChatSessionUpdate.mock.calls.find(
      (call) => (call[0] as { data: Record<string, unknown> }).data.messageCount !== undefined,
    );
    expect(agentEndUpdate).toBeDefined();
    expect(
      (agentEndUpdate![0] as { data: Record<string, unknown> }).data.lastActivityAt,
    ).toBeInstanceOf(Date);
  });

  it("dispose() stops listening for events", async () => {
    const { published } = setup();
    mockSaveAssistantMessage.mockResolvedValue({ id: "msg-1" });

    const session = createFakeSession();
    const tracker = createSessionEventTracker({ sessionId: "s1", userId: "u1", session });

    tracker.dispose();
    session.emit({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "ignored" }] },
    });

    expect(published).toHaveLength(0);
  });

  it("never calls session.compact() mid-run, even when usage crosses 85%", async () => {
    const { published } = setup();
    mockSaveAssistantMessage.mockResolvedValue({ id: "msg-1" });

    const session = createFakeSession();
    createSessionEventTracker({ sessionId: "s1", userId: "u1", session });

    session.emit({ type: "agent_start" });
    // Multi-turn run: each assistant message_end reports usage that pushes
    // the cumulative total far past any threshold. The old bug called
    // session.compact() on EVERY such event (it aborted the run and,
    // without an in-flight guard, double-compacted).
    for (let i = 0; i < 3; i++) {
      session.emit({
        type: "message_update",
        message: { role: "assistant", content: [{ type: "text", text: `turn ${i}` }] },
      });
      session.emit({
        type: "message_end",
        message: {
          role: "assistant",
          usage: { input: 60_000, output: 6_000, cacheRead: 0, cacheWrite: 0 },
        },
      });
      session.emit({
        type: "turn_end",
        message: { role: "assistant", content: [{ type: "text", text: `turn ${i}` }] },
        toolResults: [],
      });
    }

    await flush();

    expect(session.compact).not.toHaveBeenCalled();
    // Usage is still tracked and published for the UI.
    const usageEvents = published.filter((p) => p.event === "token_usage");
    expect(usageEvents.length).toBe(3);
    expect(usageEvents[2]!.data.total).toBe(198_000);
  });

  it("publishes Pi's own context size instead of summing per-message usage", async () => {
    const { published } = setup();

    const session = createFakeSession({ contextTokens: 42_000, contextWindow: 100_000 });
    createSessionEventTracker({ sessionId: "s1", userId: "u1", session });

    // A cached Anthropic-style response: nearly all of the prompt is a cache
    // read, so `input` alone says nothing about how full the context is.
    session.emit({ type: "agent_start" });
    session.emit({
      type: "message_end",
      message: {
        role: "assistant",
        usage: { input: 350, output: 900, cacheRead: 41_000, cacheWrite: 0 },
      },
    });

    await flush();

    const usage = published.find((p) => p.event === "token_usage")!;
    // Context occupancy comes from Pi, not from the (cache-excluded) counters.
    expect(usage.data.contextTokens).toBe(42_000);
    expect(usage.data.contextWindow).toBe(100_000);
    // Billed totals include the cache read, so the tooltip isn't a lie either.
    expect(usage.data.input).toBe(350);
    expect(usage.data.cacheRead).toBe(41_000);
    expect(usage.data.total).toBe(42_250);
  });

  it("publishes a null context size when Pi has none yet", async () => {
    const { published } = setup();

    // Right after a compaction and before the next response, Pi reports no
    // trustworthy token count. The event must still go out (the UI shows
    // "unavailable") rather than publishing a stale or invented number.
    const session = createFakeSession({ contextTokens: null });
    createSessionEventTracker({ sessionId: "s1", userId: "u1", session });

    session.emit({ type: "agent_start" });
    session.emit({
      type: "message_end",
      message: {
        role: "assistant",
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
      },
    });

    await flush();

    const usage = published.find((p) => p.event === "token_usage")!;
    expect(usage.data.contextTokens).toBeNull();
    expect(usage.data.contextWindow).toBe(100_000);
  });

  it("persists SDK auto-compaction between agent_end and agent_settled, defers done", async () => {
    const { published } = setup();
    mockSaveAssistantMessage.mockResolvedValue({ id: "msg-1" });

    const session = createFakeSession();
    createSessionEventTracker({ sessionId: "s1", userId: "u1", session });

    emitRun(session, "Final answer");
    // The SDK runs auto-compaction after agent_end (before settling).
    session.emit({ type: "compaction_start", reason: "threshold" });
    session.emit({
      type: "compaction_end",
      reason: "threshold",
      result: { summary: "Summary of the conversation", tokensBefore: 150_000 },
      aborted: false,
      willRetry: false,
    });
    session.emit({ type: "agent_settled" });

    await flush();
    await flush();
    await flush();

    // Compaction summary is persisted and forwarded.
    expect(mockSaveCompactionMessage).toHaveBeenCalledWith({
      sessionId: "s1",
      summary: "Summary of the conversation",
      tokensBefore: 150_000,
    });
    expect(published.map((p) => p.event)).toContain("compaction_start");
    expect(published.map((p) => p.event)).toContain("compaction_end");

    // done is emitted exactly once, only after settling.
    const doneEvents = published.filter((p) => p.event === "done");
    expect(doneEvents).toHaveLength(1);
    expect(published.findIndex((p) => p.event === "done")).toBeGreaterThan(
      published.findIndex((p) => p.event === "compaction_end"),
    );

    // The tracker disposed itself: later events are ignored.
    session.emit({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "after settle" }] },
    });
    expect(published.some((p) => p.event === "token")).toBe(true);
    const tokensAfter = published.filter((p) => p.event === "token").map((p) => p.data.text);
    expect(tokensAfter).not.toContain("after settle");
  });

  it("does not save a manual compaction the owning request persists", async () => {
    const { published } = setup();
    mockSaveAssistantMessage.mockResolvedValue({ id: "msg-1" });

    const session = createFakeSession();
    createSessionEventTracker({ sessionId: "s1", userId: "u1", session });

    // A /compact route owns manual compaction: it saves the summary itself. The
    // tracker can be subscribed while one runs (a run it aborted settles after
    // the compaction began), and saving here too duplicates the summary.
    session.emit({ type: "compaction_start", reason: "manual" });
    session.emit({
      type: "compaction_end",
      reason: "manual",
      result: { summary: "Manual summary", tokensBefore: 90_000 },
      aborted: false,
      willRetry: false,
    });

    await flush();

    expect(mockSaveCompactionMessage).not.toHaveBeenCalled();
    // Connected clients still learn that the compaction finished.
    const compactionEnd = published.find((p) => p.event === "compaction_end");
    expect(compactionEnd?.data.summary).toBe("Manual summary");
  });

  it("handles a continuation run (overflow retry) and emits done only once", async () => {
    const { published } = setup();
    mockSaveAssistantMessage.mockResolvedValue({ id: "msg-1" });

    const session = createFakeSession();
    createSessionEventTracker({ sessionId: "s1", userId: "u1", session });

    // Run 1: the context-overflow turn (agent stops, SDK compacts+continues).
    session.emit({ type: "agent_start" });
    session.emit({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "overflow" }] },
    });
    session.emit({
      type: "message_end",
      message: {
        role: "assistant",
        usage: { input: 90_000, output: 5_000, cacheRead: 0, cacheWrite: 0 },
      },
    });
    session.emit({
      type: "turn_end",
      message: { role: "assistant", content: [{ type: "text", text: "overflow" }] },
      toolResults: [],
    });
    session.emit({
      type: "agent_end",
      messages: [{ role: "assistant", content: [{ type: "text", text: "overflow" }] }],
    });
    session.emit({ type: "compaction_start", reason: "overflow" });
    session.emit({
      type: "compaction_end",
      reason: "overflow",
      result: { summary: "Compacted", tokensBefore: 180_000 },
      aborted: false,
      willRetry: true,
    });
    // Run 2: the SDK continued the interrupted turn.
    session.emit({ type: "agent_start" });
    session.emit({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "Recovered answer" }] },
    });
    session.emit({
      type: "turn_end",
      message: { role: "assistant", content: [{ type: "text", text: "Recovered answer" }] },
      toolResults: [],
    });
    session.emit({
      type: "agent_end",
      messages: [{ role: "assistant", content: [{ type: "text", text: "Recovered answer" }] }],
    });
    session.emit({ type: "agent_settled" });

    await flush();
    await flush();
    await flush();

    const events = published.map((p) => p.event);
    expect(events.filter((e) => e === "done")).toHaveLength(1);
    // Both turns were tracked (2 turn_starts, done only after the final settle).
    expect(events.filter((e) => e === "turn_start")).toHaveLength(2);
    expect(events.indexOf("done")).toBeGreaterThan(events.lastIndexOf("turn_end"));

    // Message count covers all turns of both runs.
    expect(mockChatSessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "s1" },
        data: { messageCount: { increment: 2 }, lastActivityAt: expect.any(Date) },
      }),
    );
  });

  it("persists the provider error on a terminal failure", async () => {
    setup();
    mockSaveAssistantMessage.mockResolvedValue({ id: "msg-1" });

    const session = createFakeSession();
    createSessionEventTracker({ sessionId: "s1", userId: "u1", session });

    // A provider failure is an assistant message with stopReason "error" and
    // no content — Pi does not throw, so this is the only failure signal.
    const failed = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: '400: {"message":"Invalid max_tokens value"}',
    };
    session.emit({ type: "agent_start" });
    session.emit({ type: "message_end", message: failed });
    session.emit({ type: "turn_end", message: failed, toolResults: [] });
    session.emit({ type: "agent_end", messages: [failed], willRetry: false });

    await flush();
    await flush();

    // turn_end cannot know whether the attempt will be retried, so the error is
    // written by the terminal agent_end finalize only.
    const turnSave = mockSaveAssistantMessage.mock.calls[0]![0] as { errorMessage?: string };
    expect(turnSave.errorMessage).toBeUndefined();
    const finalSave = mockSaveAssistantMessage.mock.calls.at(-1)![0] as { errorMessage?: string };
    expect(finalSave.errorMessage).toBe('400: {"message":"Invalid max_tokens value"}');
  });

  it("keeps partial output from an attempt that is about to be retried", async () => {
    setup();
    mockSaveAssistantMessage.mockResolvedValue({ id: "msg-1" });

    const session = createFakeSession();
    createSessionEventTracker({ sessionId: "s1", userId: "u1", session });

    // The stream died after the model had already produced text the user saw.
    const failed = {
      role: "assistant",
      content: [{ type: "text", text: "Starting to answer" }],
      stopReason: "error",
      errorMessage: "terminated",
    };
    session.emit({ type: "agent_start" });
    session.emit({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "Starting to answer" }] },
    });
    session.emit({ type: "turn_end", message: failed, toolResults: [] });
    session.emit({ type: "agent_end", messages: [failed], willRetry: true });

    await flush();
    await flush();

    // Nothing is deleted, and no error is reported: the attempt is provisional,
    // so the run's outcome is still open (a retry, or a user pressing stop).
    expect(mockChatMessageDeleteMany).not.toHaveBeenCalled();
    const saves = mockSaveAssistantMessage.mock.calls.map((c) => c[0] as { errorMessage?: string });
    expect(saves).toHaveLength(1);
    expect(saves[0]!.errorMessage).toBeUndefined();
  });

  it("does not record a user's stop as a provider error", async () => {
    setup();
    mockSaveAssistantMessage.mockResolvedValue({ id: "msg-1" });

    const session = createFakeSession();
    createSessionEventTracker({ sessionId: "s1", userId: "u1", session });

    // A cancelled request is reported exactly like a stream failure
    // (stopReason "error", errorMessage "terminated"), and the SDK marks it
    // retryable — the retry is what the abort then cancels.
    const aborted = {
      role: "assistant",
      content: [{ type: "text", text: "half an answer" }],
      stopReason: "error",
      errorMessage: "terminated",
    };
    session.emit({ type: "agent_start" });
    session.emit({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "half an answer" }] },
    });
    session.emit({ type: "turn_end", message: aborted, toolResults: [] });
    session.emit({ type: "agent_end", messages: [aborted], willRetry: true });
    session.emit({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2000,
      errorMessage: "terminated",
    });
    session.emit({ type: "auto_retry_end", success: false, attempt: 1, finalError: "cancelled" });
    session.emit({ type: "agent_settled" });

    await flush();
    await flush();
    await flush();

    // The partial answer survives, with no error attached to it.
    expect(mockChatMessageDeleteMany).not.toHaveBeenCalled();
    const saves = mockSaveAssistantMessage.mock.calls.map((c) => c[0] as { errorMessage?: string });
    expect(saves.every((save) => save.errorMessage === undefined)).toBe(true);
  });

  it("ignores an SDK message with a true abort stop reason", async () => {
    setup();
    mockSaveAssistantMessage.mockResolvedValue({ id: "msg-1" });

    const session = createFakeSession();
    createSessionEventTracker({ sessionId: "s1", userId: "u1", session });

    const aborted = {
      role: "assistant",
      content: [{ type: "text", text: "partial" }],
      stopReason: "aborted",
      errorMessage: "Request was aborted",
    };
    session.emit({ type: "agent_start" });
    session.emit({ type: "turn_end", message: aborted, toolResults: [] });
    session.emit({ type: "agent_end", messages: [aborted], willRetry: false });

    await flush();
    await flush();

    const finalSave = mockSaveAssistantMessage.mock.calls.at(-1)![0] as { errorMessage?: string };
    expect(finalSave.errorMessage).toBeNull();
  });

  it("discards the failed turn when the SDK retries, keeping earlier turns", async () => {
    const { published } = setup();
    let savedCounter = 0;
    mockSaveAssistantMessage.mockImplementation(() => {
      savedCounter++;
      return Promise.resolve({ id: `msg-${savedCounter}` });
    });

    const session = createFakeSession();
    createSessionEventTracker({ sessionId: "s1", userId: "u1", session });

    // Attempt 1, turn 1: a real answer with a tool call — the SDK keeps this.
    session.emit({ type: "agent_start" });
    session.emit({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "Working on it" }] },
    });
    session.emit({
      type: "turn_end",
      message: { role: "assistant", content: [{ type: "text", text: "Working on it" }] },
      toolResults: [],
    });
    // Attempt 1, turn 2: the provider fails transiently.
    const failed = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "503: service unavailable",
    };
    session.emit({ type: "turn_end", message: failed, toolResults: [] });
    session.emit({ type: "agent_end", messages: [failed], willRetry: true });
    session.emit({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2000,
      errorMessage: "503: service unavailable",
    });

    await flush();
    await flush();

    // Only the failed turn's row is removed (`_prepareRetry` drops just the
    // last message) — the earlier turn stays part of the transcript.
    expect(mockChatMessageDeleteMany).toHaveBeenCalledTimes(1);
    expect(mockChatMessageDeleteMany).toHaveBeenCalledWith({
      where: { id: "msg-2", sessionId: "s1" },
    });

    // agent_end must not have persisted the doomed turn.
    const savedIds = mockSaveAssistantMessage.mock.calls.map(
      (c) => (c[0] as { messageId?: string }).messageId,
    );
    expect(savedIds).toEqual([undefined, undefined]);

    // The client is told to drop the bubble; retry progress is published.
    const discarded = published.find((p) => p.event === "turn_discarded")!;
    expect(discarded.data.messageId).toBe("msg-2");
    expect(typeof discarded.data.turnId).toBe("string");

    const retryStart = published.find((p) => p.event === "retry_start")!;
    expect(retryStart.data).toMatchObject({ attempt: 1, maxAttempts: 3, delayMs: 2000 });
  });

  it("starts a fresh group after discarding the root message", async () => {
    const { published } = setup();
    let savedCounter = 0;
    mockSaveAssistantMessage.mockImplementation(() => {
      savedCounter++;
      return Promise.resolve({ id: `msg-${savedCounter}` });
    });

    const session = createFakeSession();
    createSessionEventTracker({ sessionId: "s1", userId: "u1", session });

    // Single-turn failure: the doomed row IS the generation's root, so the
    // retried turn must not be linked to the deleted message.
    const failed = { role: "assistant", content: [], stopReason: "error", errorMessage: "429" };
    session.emit({ type: "agent_start" });
    session.emit({ type: "turn_end", message: failed, toolResults: [] });
    session.emit({ type: "agent_end", messages: [failed], willRetry: true });
    session.emit({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2000,
      errorMessage: "429",
    });

    await flush();
    await flush();

    // Retry succeeds.
    session.emit({ type: "agent_start" });
    session.emit({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "Recovered" }] },
    });
    session.emit({
      type: "turn_end",
      message: { role: "assistant", content: [{ type: "text", text: "Recovered" }] },
      toolResults: [],
    });

    await flush();

    const retriedSave = mockSaveAssistantMessage.mock.calls.at(-1)![0] as {
      parentMessageId?: string | null;
    };
    expect(retriedSave.parentMessageId).toBeNull();
    expect(published.find((p) => p.event === "turn_discarded")!.data.messageId).toBe("msg-1");
  });

  it("does not count discarded attempts in the session message count", async () => {
    setup();
    mockSaveAssistantMessage.mockResolvedValue({ id: "msg-1" });

    const session = createFakeSession();
    createSessionEventTracker({ sessionId: "s1", userId: "u1", session });

    const failed = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "503: service unavailable",
    };

    // Three attempts fail and are discarded, the fourth is terminal.
    for (let attempt = 0; attempt < 3; attempt++) {
      session.emit({ type: "agent_start" });
      session.emit({ type: "turn_end", message: failed, toolResults: [] });
      session.emit({ type: "agent_end", messages: [failed], willRetry: true });
    }
    session.emit({ type: "agent_start" });
    session.emit({ type: "turn_end", message: failed, toolResults: [] });
    session.emit({ type: "agent_end", messages: [failed], willRetry: false });
    session.emit({ type: "agent_settled" });

    await flush();
    await flush();
    await flush();

    // Only the terminal attempt left a row, so the count must match it.
    expect(mockChatMessageDeleteMany).toHaveBeenCalledTimes(3);
    expect(mockChatSessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ messageCount: { increment: 1 } }),
      }),
    );
  });

  it("does not report a user's stop on the terminal attempt as a provider error", async () => {
    setup();
    mockSaveAssistantMessage.mockResolvedValue({ id: "msg-1" });

    const session = createFakeSession();
    createSessionEventTracker({ sessionId: "s1", userId: "u1", session });

    // The user presses Stop during a run that has no retries left, so Pi does
    // not mark the attempt retryable — it looks exactly like a hard failure.
    const stopped = {
      role: "assistant",
      content: [{ type: "text", text: "half an answer" }],
      stopReason: "error",
      errorMessage: "terminated",
    };
    session.emit({ type: "agent_start" });
    requestSessionAbort("u1", "s1");
    session.emit({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "half an answer" }] },
    });
    session.emit({ type: "turn_end", message: stopped, toolResults: [] });
    session.emit({ type: "agent_end", messages: [stopped], willRetry: false });
    session.emit({ type: "agent_settled" });

    await flush();
    await flush();
    await flush();

    // The partial answer survives and carries no error.
    expect(mockChatMessageDeleteMany).not.toHaveBeenCalled();
    const saves = mockSaveAssistantMessage.mock.calls.map((c) => c[0] as { errorMessage?: string });
    expect(
      saves.every((save) => save.errorMessage === undefined || save.errorMessage === null),
    ).toBe(true);
  });

  it("does not let a stale stop request swallow a later real failure", async () => {
    setup();
    mockSaveAssistantMessage.mockResolvedValue({ id: "msg-1" });

    const session = createFakeSession();
    createSessionEventTracker({ sessionId: "s1", userId: "u1", session });

    // A stop requested after the previous run had already finished.
    requestSessionAbort("u1", "s1");

    const failed = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: '400: {"message":"Invalid max_tokens value"}',
    };
    // The new run clears it, so this genuine failure is reported.
    session.emit({ type: "agent_start" });
    session.emit({ type: "turn_end", message: failed, toolResults: [] });
    session.emit({ type: "agent_end", messages: [failed], willRetry: false });

    await flush();
    await flush();

    const finalSave = mockSaveAssistantMessage.mock.calls.at(-1)![0] as { errorMessage?: string };
    expect(finalSave.errorMessage).toBe('400: {"message":"Invalid max_tokens value"}');
    // The mark is consumed by the run it was meant for.
    expect(wasSessionAbortRequested("u1", "s1")).toBe(false);
  });

  it("publishes the end of a retry sequence", async () => {
    const { published } = setup();
    mockSaveAssistantMessage.mockResolvedValue({ id: "msg-1" });

    const session = createFakeSession();
    createSessionEventTracker({ sessionId: "s1", userId: "u1", session });

    session.emit({ type: "agent_start" });
    session.emit({ type: "auto_retry_end", success: false, attempt: 3, finalError: "503" });
    session.emit({ type: "agent_start" });
    session.emit({ type: "auto_retry_end", success: true, attempt: 2 });

    await flush();

    const retryEnds = published.filter((p) => p.event === "retry_end");
    expect(retryEnds).toHaveLength(2);
    expect(retryEnds[0]!.data).toMatchObject({ success: false, attempt: 3, finalError: "503" });
    expect(retryEnds[1]!.data).toMatchObject({ success: true, attempt: 2 });
  });
});
