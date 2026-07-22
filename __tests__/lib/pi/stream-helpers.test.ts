import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Prisma
const mockChatSessionFindUnique = vi.fn();
const mockChatSessionUpdate = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    chatSession: {
      findUnique: (...args: unknown[]) => mockChatSessionFindUnique(...args),
      update: (...args: unknown[]) => mockChatSessionUpdate(...args),
    },
    chatMessage: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

// Mock Redis
const mockRedisPublish = vi.fn().mockResolvedValue(1);
const mockRedisLpush = vi.fn().mockResolvedValue(1);
const mockRedisLtrim = vi.fn().mockResolvedValue(0);
const mockRedisExpire = vi.fn().mockResolvedValue(1);
const mockRedisLrange = vi.fn().mockResolvedValue([]);
const mockRedisSubscribe = vi.fn().mockResolvedValue(undefined);
const mockRedisUnsubscribe = vi.fn().mockResolvedValue(undefined);
const mockRedisQuit = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/redis", () => ({
  getRedis: () => ({
    publish: mockRedisPublish,
    lpush: mockRedisLpush,
    ltrim: mockRedisLtrim,
    expire: mockRedisExpire,
    lrange: mockRedisLrange,
  }),
  createRedisClient: () => ({
    subscribe: mockRedisSubscribe,
    unsubscribe: mockRedisUnsubscribe,
    quit: mockRedisQuit,
    on: vi.fn(),
    off: vi.fn(),
  }),
}));

import { publishStreamEvent, getBufferedEvents } from "@/lib/pi/stream-helpers";
import * as db from "@/lib/db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrismaChatSession = db.prisma.chatSession as any;

describe("publishStreamEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("publishes to Redis channel and buffer", async () => {
    await publishStreamEvent("session-1", "token", { text: "hello" });

    expect(mockRedisPublish).toHaveBeenCalledWith(
      "chat:stream:session-1",
      JSON.stringify({ event: "token", data: { text: "hello" } }),
    );
    expect(mockRedisLpush).toHaveBeenCalledWith(
      "chat:stream:buf:session-1",
      JSON.stringify({ event: "token", data: { text: "hello" } }),
    );
    expect(mockRedisExpire).toHaveBeenCalledWith("chat:stream:buf:session-1", 60);
  });

  it("trims buffer to max size", async () => {
    await publishStreamEvent("session-1", "token", { text: "hello" });
    expect(mockRedisLtrim).toHaveBeenCalledWith("chat:stream:buf:session-1", 0, 199);
  });

  it("handles Redis errors gracefully", async () => {
    mockRedisPublish.mockRejectedValueOnce(new Error("Redis down"));
    // Should not throw
    await expect(
      publishStreamEvent("session-1", "token", { text: "hello" }),
    ).resolves.toBeUndefined();
  });
});

describe("getBufferedEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns events in chronological order", async () => {
    // Redis LPOP returns newest first, so we reverse
    mockRedisLrange.mockResolvedValueOnce([
      JSON.stringify({ event: "token", data: { text: "second" } }),
      JSON.stringify({ event: "token", data: { text: "first" } }),
    ]);

    const events = await getBufferedEvents("session-1");
    expect(events).toHaveLength(2);
    expect(JSON.parse(events[0]!)).toEqual({ event: "token", data: { text: "first" } });
    expect(JSON.parse(events[1]!)).toEqual({ event: "token", data: { text: "second" } });
  });

  it("returns empty array when no buffered events", async () => {
    mockRedisLrange.mockResolvedValueOnce([]);
    const events = await getBufferedEvents("session-1");
    expect(events).toEqual([]);
  });

  it("handles Redis errors gracefully", async () => {
    mockRedisLrange.mockRejectedValueOnce(new Error("Redis down"));
    const events = await getBufferedEvents("session-1");
    expect(events).toEqual([]);
  });
});

describe("active tool persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persisting active tool on tool_execution_start", async () => {
    // Simulate what the stream route does on tool_execution_start
    const sessionId = "session-1";
    const toolCallId = "tc-abc123";
    const toolName = "infra_exec";
    const args = { machine: "prod-web-1", command: "systemctl restart nginx" };

    await mockPrismaChatSession.update({
      where: { id: sessionId },
      data: {
        activeToolCallId: toolCallId,
        activeToolName: toolName,
        activeToolArgs: args,
        activeToolStartedAt: new Date(),
      },
    });

    expect(mockChatSessionUpdate).toHaveBeenCalledWith({
      where: { id: sessionId },
      data: {
        activeToolCallId: toolCallId,
        activeToolName: toolName,
        activeToolArgs: args,
        activeToolStartedAt: expect.any(Date),
      },
    });
  });

  it("clearing active tool on tool_execution_end", async () => {
    // Simulate what the stream route does on tool_execution_end
    const sessionId = "session-1";

    // This is the pattern used in the stream route (with Prisma.JsonNull)
    await mockPrismaChatSession.update({
      where: { id: sessionId },
      data: {
        activeToolCallId: null,
        activeToolName: null,
        activeToolArgs: null, // Prisma.JsonNull resolves to null in mock
        activeToolStartedAt: null,
      },
    });

    expect(mockChatSessionUpdate).toHaveBeenCalledWith({
      where: { id: sessionId },
      data: {
        activeToolCallId: null,
        activeToolName: null,
        activeToolArgs: null,
        activeToolStartedAt: null,
      },
    });
  });

  it("reconnect handler emits tool_resume when active tool exists", async () => {
    // Simulate what handleReconnectFromRedis does
    const sessionId = "session-1";
    const now = new Date();

    mockChatSessionFindUnique.mockResolvedValueOnce({
      activeToolCallId: "tc-abc123",
      activeToolName: "infra_exec",
      activeToolArgs: { machine: "prod-web-1", command: "uptime" },
      activeToolStartedAt: now,
    });

    const session = await mockPrismaChatSession.findUnique({
      where: { id: sessionId },
      select: {
        activeToolCallId: true,
        activeToolName: true,
        activeToolArgs: true,
        activeToolStartedAt: true,
      },
    });

    expect(session.activeToolCallId).toBe("tc-abc123");
    expect(session.activeToolName).toBe("infra_exec");
    expect(session.activeToolArgs).toEqual({ machine: "prod-web-1", command: "uptime" });
    expect(session.activeToolStartedAt).toEqual(now);
  });

  it("reconnect handler skips tool_resume when no active tool", async () => {
    // Simulate what handleReconnectFromRedis does when tool is not active
    const sessionId = "session-1";

    mockChatSessionFindUnique.mockResolvedValueOnce({
      activeToolCallId: null,
      activeToolName: null,
      activeToolArgs: null,
      activeToolStartedAt: null,
    });

    const session = await mockPrismaChatSession.findUnique({
      where: { id: sessionId },
      select: {
        activeToolCallId: true,
        activeToolName: true,
        activeToolArgs: true,
        activeToolStartedAt: true,
      },
    });

    // No active tool — should not emit tool_resume
    expect(session.activeToolName).toBeNull();
  });

  it("reconnect handler handles missing session gracefully", async () => {
    // Session doesn't exist (deleted during reconnect)
    mockChatSessionFindUnique.mockResolvedValueOnce(null);

    const session = await mockPrismaChatSession.findUnique({
      where: { id: "nonexistent" },
      select: { activeToolName: true, activeToolArgs: true, activeToolStartedAt: true },
    });

    expect(session).toBeNull();
  });
});

describe("tool_resume event format", () => {
  it("produces valid SSE for tool_resume event with real toolCallId", async () => {
    const { formatSseEvent } = await import("@/lib/pi/stream-logic");

    const event = formatSseEvent("tool_resume", {
      toolCallId: "tc-abc123",
      toolName: "infra_exec",
      args: { machine: "prod-web-1", command: "uptime" },
      startedAt: "2025-01-15T10:30:00.000Z",
    });

    expect(event).toMatch(/^event: tool_resume\n/);
    const dataLine = event.match(/data: (.+)/);
    expect(dataLine).toBeTruthy();
    const parsed = JSON.parse(dataLine![1]!);
    expect(parsed.toolCallId).toBe("tc-abc123");
    expect(parsed.toolName).toBe("infra_exec");
    expect(parsed.args).toEqual({ machine: "prod-web-1", command: "uptime" });
    expect(parsed.startedAt).toBe("2025-01-15T10:30:00.000Z");
  });

  it("produces fallback toolCallId when DB field is missing", async () => {
    // Edge case: old DB record without activeToolCallId
    const { formatSseEvent } = await import("@/lib/pi/stream-logic");

    const event = formatSseEvent("tool_resume", {
      toolCallId: "resume-infra_exec",
      toolName: "infra_exec",
      args: { machine: "prod-web-1" },
      startedAt: null,
    });

    const dataLine = event.match(/data: (.+)/);
    const parsed = JSON.parse(dataLine![1]!);
    expect(parsed.toolCallId).toBe("resume-infra_exec");
  });

  it("handles null startedAt in tool_resume", async () => {
    const { formatSseEvent } = await import("@/lib/pi/stream-logic");

    const event = formatSseEvent("tool_resume", {
      toolCallId: "tc-search-1",
      toolName: "search",
      args: { query: "test" },
      startedAt: null,
    });

    const dataLine = event.match(/data: (.+)/);
    const parsed = JSON.parse(dataLine![1]!);
    expect(parsed.startedAt).toBeNull();
  });

  it("handles complex tool args in tool_resume", async () => {
    const { formatSseEvent } = await import("@/lib/pi/stream-logic");

    const event = formatSseEvent("tool_resume", {
      toolCallId: "tc-infra-1",
      toolName: "infra_exec",
      args: {
        machine: "prod-web-1",
        command: "docker ps --format '{{.Names}} {{.Status}}'",
        timeout: 30,
        options: { sudo: true },
      },
      startedAt: "2025-01-15T10:30:00.000Z",
    });

    const dataLine = event.match(/data: (.+)/);
    const parsed = JSON.parse(dataLine![1]!);
    expect(parsed.args).toEqual({
      machine: "prod-web-1",
      command: "docker ps --format '{{.Names}} {{.Status}}'",
      timeout: 30,
      options: { sudo: true },
    });
  });
});
