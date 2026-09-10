import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Prisma
const mockChatMessageCreate = vi.fn();
const mockChatMessageUpdate = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    chatMessage: {
      create: (...args: unknown[]) => mockChatMessageCreate(...args),
      update: (...args: unknown[]) => mockChatMessageUpdate(...args),
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

    const result = await saveAssistantMessage({ sessionId: "session-1", content: "Hello world" });

    expect(mockChatMessageCreate).toHaveBeenCalledWith({
      data: {
        sessionId: "session-1",
        role: "assistant",
        content: "Hello world",
        thinking: null,
        toolCalls: null,
        errorMessage: null,
        parentMessageId: null,
      },
    });
    expect(result).toEqual({ id: "msg-1" });
  });

  it("saves thinking content when provided", async () => {
    mockChatMessageCreate.mockResolvedValueOnce({ id: "msg-2" });

    await saveAssistantMessage({
      sessionId: "session-1",
      content: "Answer",
      thinking: "Let me think...",
    });

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

    await saveAssistantMessage({ sessionId: "session-1", content: "Result", toolCalls });

    expect(mockChatMessageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        toolCalls: JSON.stringify(toolCalls),
      }),
    });
  });

  it("sets toolCalls to null when empty array", async () => {
    mockChatMessageCreate.mockResolvedValueOnce({ id: "msg-4" });

    await saveAssistantMessage({ sessionId: "session-1", content: "Result", toolCalls: [] });

    expect(mockChatMessageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        toolCalls: null,
      }),
    });
  });

  it("sets toolCalls to null when undefined", async () => {
    mockChatMessageCreate.mockResolvedValueOnce({ id: "msg-5" });

    await saveAssistantMessage({ sessionId: "session-1", content: "Result" });

    expect(mockChatMessageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        toolCalls: null,
      }),
    });
  });

  it("saves parentMessageId when provided", async () => {
    mockChatMessageCreate.mockResolvedValueOnce({ id: "msg-6" });

    await saveAssistantMessage({
      sessionId: "session-1",
      content: "Follow-up",
      parentMessageId: "parent-1",
    });

    expect(mockChatMessageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        parentMessageId: "parent-1",
      }),
    });
  });

  it("sets parentMessageId to null when undefined", async () => {
    mockChatMessageCreate.mockResolvedValueOnce({ id: "msg-7" });

    await saveAssistantMessage({ sessionId: "session-1", content: "First turn" });

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

    await saveAssistantMessage({ sessionId: "session-1", content: "Error response", toolCalls });

    expect(mockChatMessageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        toolCalls: JSON.stringify(toolCalls),
      }),
    });
  });

  it("persists the provider error on a failed turn", async () => {
    mockChatMessageCreate.mockResolvedValueOnce({ id: "msg-9" });

    await saveAssistantMessage({
      sessionId: "session-1",
      content: "",
      errorMessage: '400: {"message":"Invalid max_tokens value"}',
    });

    expect(mockChatMessageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        errorMessage: '400: {"message":"Invalid max_tokens value"}',
      }),
    });
  });

  it("updates the existing message and clears a stale error", async () => {
    mockChatMessageUpdate.mockResolvedValueOnce({ id: "msg-10" });

    await saveAssistantMessage({
      sessionId: "session-1",
      content: "Final answer",
      messageId: "msg-10",
    });

    expect(mockChatMessageCreate).not.toHaveBeenCalled();
    expect(mockChatMessageUpdate).toHaveBeenCalledWith({
      where: { id: "msg-10", sessionId: "session-1" },
      data: {
        content: "Final answer",
        thinking: null,
        toolCalls: null,
        errorMessage: null,
      },
    });
  });
});
