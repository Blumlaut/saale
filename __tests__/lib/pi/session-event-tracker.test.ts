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

vi.mock("@/lib/chat/compaction", () => ({
  saveCompactionMessage: vi.fn().mockResolvedValue(undefined),
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
  return { published };
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

  it("unregisters the active session and bumps the message count at agent_end", async () => {
    setup();
    mockSaveAssistantMessage.mockResolvedValue({ id: "msg-1" });

    const session = createFakeSession();
    createSessionEventTracker({ sessionId: "s1", userId: "u1", session });

    session.emit({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "Hi" }] },
    });
    session.emit({
      type: "turn_end",
      message: { role: "assistant", content: [{ type: "text", text: "Hi" }] },
      toolResults: [],
    });
    session.emit({
      type: "agent_end",
      messages: [{ role: "assistant", content: [{ type: "text", text: "Hi" }] }],
    });

    await flush();
    await flush();

    expect(mockUnregisterActiveSession).toHaveBeenCalledWith("u1", "s1");
    expect(mockChatSessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "s1" },
        data: { messageCount: { increment: 1 } },
      }),
    );
  });

  it("keeps the active session flag fresh during long runs (heartbeat)", async () => {
    setup();
    mockSaveAssistantMessage.mockResolvedValue({ id: "msg-1" });

    const session = createFakeSession();
    createSessionEventTracker({ sessionId: "s1", userId: "u1", session });

    session.emit({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "tick" }] },
    });

    expect(mockRegisterActiveSession).toHaveBeenCalledWith("u1", "s1");
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
});
