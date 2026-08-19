import { describe, it, expect, vi, beforeEach } from "vitest";

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
vi.mock("@/lib/redis", () => ({
  registerActiveSession: (...args: unknown[]) => mockRegisterActiveSession(...args),
  unregisterActiveSession: (...args: unknown[]) => mockUnregisterActiveSession(...args),
}));

const mockChatSessionUpdate = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    chatSession: {
      update: (...args: unknown[]) => mockChatSessionUpdate(...args),
    },
  },
}));

const mockSaveCompactionMessage = vi.fn();
vi.mock("@/lib/chat/compaction", () => ({
  saveCompactionMessage: (...args: unknown[]) => mockSaveCompactionMessage(...args),
}));

import { createSessionEventTracker } from "@/lib/pi/session-event-tracker";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

// ─── Helpers ────────────────────────────────────────────────────────────────

interface FakeAgentEvent {
  type: string;
  [key: string]: unknown;
}

function createFakeSession() {
  const listeners = new Set<(event: FakeAgentEvent) => void>();
  return {
    subscribe: (listener: (event: FakeAgentEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (event: FakeAgentEvent) => {
      for (const listener of [...listeners]) listener(event);
    },
    model: { contextWindow: 100_000 },
    compact: vi.fn().mockResolvedValue({ tokensBefore: 50 }),
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
      "s1",
      "Hello world",
      undefined,
      undefined,
      null,
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
      // Pi's session.isStreaming) must keep refreshing the flag.
      vi.advanceTimersByTime(30_000);
      expect(mockRegisterActiveSession).toHaveBeenCalledWith("u1", "s1");
      expect(mockRegisterActiveSession).toHaveBeenCalledTimes(1);

      // Once Pi actually stops streaming, the flag stops being refreshed.
      (session as unknown as { isStreaming: boolean }).isStreaming = false;
      vi.advanceTimersByTime(60_000);
      expect(mockRegisterActiveSession).toHaveBeenCalledTimes(1);
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
    const finalCall = mockSaveAssistantMessage.mock.calls.at(-1)!;
    expect(finalCall[0]).toBe("s1");
    expect(finalCall[1]).toBe("Final");
    // messageId (6th arg) = the turn_end save's id.
    expect(finalCall[5]).toBe("msg-1");
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
});
