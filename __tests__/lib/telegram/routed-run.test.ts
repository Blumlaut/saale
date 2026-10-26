import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const {
  mockChatSession,
  mockChatMessage,
  mockGetPoolEntry,
  mockIsSessionBusy,
  mockEnsureChatAgent,
  mockBeginChatRun,
  mockDispatchChatRun,
  mockResolveChatModel,
  mockSendTelegramMessage,
  mockCreateRenderer,
  mockRenderer,
  mockBeginTelegramRun,
  mockIsLatestMessage,
  mockAttachTelegramSession,
  mockUnregisterTelegramSession,
} = vi.hoisted(() => {
  const renderer = { onEvent: vi.fn(), finish: vi.fn() };
  return {
    mockChatSession: { findFirst: vi.fn(), update: vi.fn() },
    mockChatMessage: { create: vi.fn() },
    mockGetPoolEntry: vi.fn(),
    mockIsSessionBusy: vi.fn(),
    mockEnsureChatAgent: vi.fn(),
    mockBeginChatRun: vi.fn(),
    mockDispatchChatRun: vi.fn(),
    mockResolveChatModel: vi.fn(),
    mockSendTelegramMessage: vi.fn(),
    mockCreateRenderer: vi.fn((..._args: unknown[]) => renderer),
    mockRenderer: renderer,
    mockBeginTelegramRun: vi.fn(),
    mockIsLatestMessage: vi.fn(),
    mockAttachTelegramSession: vi.fn(),
    mockUnregisterTelegramSession: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({
  prisma: { chatSession: mockChatSession, chatMessage: mockChatMessage },
}));

vi.mock("@/lib/redis", () => ({
  isSessionBusy: (...args: unknown[]) => mockIsSessionBusy(...args),
}));

vi.mock("@/lib/pi/agent-pool", () => ({
  get: (...args: unknown[]) => mockGetPoolEntry(...args),
  getPoolKey: (userId: string, sessionId: string) => `${userId}:${sessionId}`,
}));

vi.mock("@/lib/chat/agent-run", () => ({
  ensureChatAgent: (...args: unknown[]) => mockEnsureChatAgent(...args),
  beginChatRun: (...args: unknown[]) => mockBeginChatRun(...args),
  dispatchChatRun: (...args: unknown[]) => mockDispatchChatRun(...args),
}));

vi.mock("@/lib/pi/chat-session-factory", () => ({
  resolveChatModel: (...args: unknown[]) => mockResolveChatModel(...args),
}));

vi.mock("@/lib/telegram/client", () => ({
  sendTelegramMessage: (...args: unknown[]) => mockSendTelegramMessage(...args),
  startTypingIndicator: () => () => {},
}));

vi.mock("@/lib/telegram/render", () => ({
  createTelegramRunRenderer: (...args: unknown[]) => mockCreateRenderer(...args),
}));

vi.mock("@/lib/telegram/files", () => ({
  recordTelegramDocumentAttachment: vi.fn(),
}));

vi.mock("@/lib/telegram/session-registry", () => ({
  beginTelegramRun: (...args: unknown[]) => mockBeginTelegramRun(...args),
  isLatestMessage: (...args: unknown[]) => mockIsLatestMessage(...args),
  attachTelegramSession: (...args: unknown[]) => mockAttachTelegramSession(...args),
  unregisterTelegramSession: (...args: unknown[]) => mockUnregisterTelegramSession(...args),
}));

const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

import { runRoutedTelegramMessage } from "@/lib/telegram/routed-run";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const userId = "user-1";
const sessionId = "sess-1";
const chatId = BigInt("119075844");

const chat = {
  id: sessionId,
  title: "New Chat",
  titleSource: "default",
  modelProvider: null,
  modelName: null,
  thinkingLevel: "off",
  toolConfig: null,
};

const pooledSession = { subscribe: vi.fn(() => vi.fn()), isStreaming: false, abort: vi.fn() };
const entry = { session: pooledSession, promptInFlight: false, lastPromptedMessageId: null };

const params = {
  userId,
  encryptedToken: "enc",
  telegramChatId: chatId,
  sessionId,
  promptText: "what did that alert mean?",
  agentPrompt: "what did that alert mean?",
  messageSeq: 3,
  donePromise: Promise.resolve(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockChatSession.findFirst.mockResolvedValue(chat);
  mockChatSession.update.mockResolvedValue({});
  mockChatMessage.create.mockResolvedValue({ id: "msg-1" });
  mockResolveChatModel.mockResolvedValue({ provider: "anthropic", name: "claude" });
  mockGetPoolEntry.mockReturnValue(undefined);
  mockIsSessionBusy.mockResolvedValue(false);
  mockEnsureChatAgent.mockResolvedValue({ entry, existedAlready: false });
  mockBeginChatRun.mockResolvedValue(undefined);
  mockDispatchChatRun.mockResolvedValue(true);
  mockIsLatestMessage.mockReturnValue(true);
  mockSendTelegramMessage.mockResolvedValue([7]);
  mockRenderer.finish.mockResolvedValue(undefined);
  entry.promptInFlight = false;
  entry.lastPromptedMessageId = null;
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("runRoutedTelegramMessage", () => {
  it("prompts the chat with the agent prompt and reports the reply", async () => {
    await runRoutedTelegramMessage(params);

    // The user's words are what the thread shows.
    expect(mockChatMessage.create).toHaveBeenCalledWith({
      data: { sessionId, role: "user", content: "what did that alert mean?" },
    });
    expect(mockBeginChatRun).toHaveBeenCalledWith({ userId, sessionId, session: pooledSession });
    expect(mockDispatchChatRun).toHaveBeenCalledWith(
      expect.objectContaining({ userId, sessionId, entry, content: "what did that alert mean?" }),
    );
    // Rendering happens through the shared renderer, so the phone and the
    // browser show the same run.
    expect(mockAttachTelegramSession).toHaveBeenCalledWith(userId, chatId, pooledSession);
    expect(mockRenderer.finish).toHaveBeenCalledWith(false);
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it("names an unnamed chat from the message", async () => {
    // The phone has no browser tab open: the chat is named by the run itself.
    await runRoutedTelegramMessage({ ...params, promptText: "fix the flaky e2e test" });

    expect(mockChatSession.update).toHaveBeenCalledWith({
      where: { id: sessionId, userId },
      data: expect.objectContaining({ title: "Fix flaky e2e test", titleSource: "auto" }),
    });
  });

  it("refuses a chat that is already generating", async () => {
    mockIsSessionBusy.mockResolvedValue(true);

    await runRoutedTelegramMessage(params);

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "enc",
      chatId,
      expect.stringContaining("busy"),
      undefined,
    );
    expect(mockChatMessage.create).not.toHaveBeenCalled();
    expect(mockDispatchChatRun).not.toHaveBeenCalled();
  });

  it("refuses a chat whose pooled agent is mid-run", async () => {
    mockGetPoolEntry.mockReturnValue({ promptInFlight: true, session: pooledSession });

    await runRoutedTelegramMessage(params);

    expect(mockDispatchChatRun).not.toHaveBeenCalled();
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "enc",
      chatId,
      expect.stringContaining("busy"),
      undefined,
    );
  });

  it("tells the user when the chat no longer exists", async () => {
    mockChatSession.findFirst.mockResolvedValue(null);

    await runRoutedTelegramMessage(params);

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "enc",
      chatId,
      expect.stringContaining("no longer exists"),
    );
    expect(mockEnsureChatAgent).not.toHaveBeenCalled();
  });

  it("tells the user when no model is configured", async () => {
    mockResolveChatModel.mockResolvedValue(undefined);

    await runRoutedTelegramMessage(params);

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "enc",
      chatId,
      expect.stringContaining("No AI model configured"),
      undefined,
    );
    expect(mockDispatchChatRun).not.toHaveBeenCalled();
  });

  it("drops a message a newer one superseded before it started", async () => {
    mockIsLatestMessage.mockReturnValue(false);

    await runRoutedTelegramMessage(params);

    expect(mockChatSession.findFirst).not.toHaveBeenCalled();
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining("superseded"));
  });

  it("releases the chat and apologises when the run fails", async () => {
    mockDispatchChatRun.mockRejectedValue(new Error("provider down"));

    await runRoutedTelegramMessage(params);

    // A failed run must not leave the chat looking busy.
    expect(entry.promptInFlight).toBe(false);
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "enc",
      chatId,
      expect.stringContaining("encountered an error"),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`failed`),
      expect.any(Error),
    );
  });

  it("tells the phone when the run failed without throwing", async () => {
    mockDispatchChatRun.mockResolvedValue(false);

    await runRoutedTelegramMessage(params);

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "enc",
      chatId,
      expect.stringContaining("encountered an error"),
    );
    expect(mockRenderer.finish).not.toHaveBeenCalled();
  });

  it("forwards an image to the vision model", async () => {
    const imageData = { type: "image" as const, data: "base64", mimeType: "image/png" };

    await runRoutedTelegramMessage({ ...params, imageData });

    expect(mockDispatchChatRun).toHaveBeenCalledWith(
      expect.objectContaining({ images: [imageData] }),
    );
  });
});
