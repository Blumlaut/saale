import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Prisma
const mockChatMessageCreate = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    chatMessage: {
      create: (...args: unknown[]) => mockChatMessageCreate(...args),
    },
  },
}));

import { saveAssistantMessage } from "@/lib/pi/stream-helpers";

describe("saveAssistantMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates an assistant message with text only", async () => {
    mockChatMessageCreate.mockResolvedValueOnce({ id: "msg-1" });

    const result = await saveAssistantMessage("session-1", "Hello world");

    expect(mockChatMessageCreate).toHaveBeenCalledWith({
      data: {
        sessionId: "session-1",
        role: "assistant",
        content: "Hello world",
        thinking: null,
        toolCalls: null,
        parentMessageId: null,
      },
    });
    expect(result).toEqual({ id: "msg-1" });
  });

  it("saves thinking content when provided", async () => {
    mockChatMessageCreate.mockResolvedValueOnce({ id: "msg-2" });

    await saveAssistantMessage("session-1", "Answer", "Let me think...");

    expect(mockChatMessageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        thinking: "Let me think...",
      }),
    });
  });

  it("saves tool calls as JSON string", async () => {
    mockChatMessageCreate.mockResolvedValueOnce({ id: "msg-3" });
    const toolCalls = [
      {
        id: "tc-1",
        name: "search",
        args: { query: "test" },
        result: "found",
        isError: false,
      },
    ];

    await saveAssistantMessage("session-1", "Result", undefined, toolCalls);

    expect(mockChatMessageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        toolCalls: JSON.stringify(toolCalls),
      }),
    });
  });

  it("sets toolCalls to null when empty array", async () => {
    mockChatMessageCreate.mockResolvedValueOnce({ id: "msg-4" });

    await saveAssistantMessage("session-1", "Result", undefined, []);

    expect(mockChatMessageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        toolCalls: null,
      }),
    });
  });

  it("sets toolCalls to null when undefined", async () => {
    mockChatMessageCreate.mockResolvedValueOnce({ id: "msg-5" });

    await saveAssistantMessage("session-1", "Result");

    expect(mockChatMessageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        toolCalls: null,
      }),
    });
  });

  it("saves parentMessageId when provided", async () => {
    mockChatMessageCreate.mockResolvedValueOnce({ id: "msg-6" });

    await saveAssistantMessage("session-1", "Follow-up", undefined, undefined, "parent-1");

    expect(mockChatMessageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        parentMessageId: "parent-1",
      }),
    });
  });

  it("sets parentMessageId to null when undefined", async () => {
    mockChatMessageCreate.mockResolvedValueOnce({ id: "msg-7" });

    await saveAssistantMessage("session-1", "First turn");

    expect(mockChatMessageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        parentMessageId: null,
      }),
    });
  });

  it("handles tool errors", async () => {
    mockChatMessageCreate.mockResolvedValueOnce({ id: "msg-8" });
    const toolCalls = [
      {
        id: "tc-err",
        name: "search",
        args: { query: "test" },
        result: "not found",
        isError: true,
      },
    ];

    await saveAssistantMessage("session-1", "Error response", undefined, toolCalls);

    expect(mockChatMessageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        toolCalls: JSON.stringify(toolCalls),
      }),
    });
  });
});
