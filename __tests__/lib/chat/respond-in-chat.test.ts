import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `chat_respond` runs a real agent turn in another chat. The guards are the
 * important part: it must never run a chat the user does not own, never run
 * the caller's own chat (that session is already running), and never start a
 * second run on a busy chat — the reply is awaited, so a queued message would
 * just deadlock the caller.
 */

const mockSessionFindFirst = vi.fn();
const mockMessageCreate = vi.fn();
const mockMessageFindFirst = vi.fn();
const mockSessionUpdate = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    chatSession: {
      findFirst: (...args: unknown[]) => mockSessionFindFirst(...args),
      update: (...args: unknown[]) => mockSessionUpdate(...args),
    },
    chatMessage: {
      create: (...args: unknown[]) => mockMessageCreate(...args),
      findFirst: (...args: unknown[]) => mockMessageFindFirst(...args),
    },
  },
}));

const mockIsSessionActive = vi.fn();
const mockUnregister = vi.fn();
vi.mock("@/lib/redis", () => ({
  isSessionActive: (...args: unknown[]) => mockIsSessionActive(...args),
  unregisterActiveSession: (...args: unknown[]) => mockUnregister(...args),
}));

const mockGetPoolEntry = vi.fn();
vi.mock("@/lib/pi/agent-pool", () => ({
  getPoolKey: (userId: string, sessionId: string) => `${userId}:${sessionId}`,
  get: (...args: unknown[]) => mockGetPoolEntry(...args),
}));

const mockResolveChatModel = vi.fn();
vi.mock("@/lib/pi/chat-session-factory", () => ({
  resolveChatModel: (...args: unknown[]) => mockResolveChatModel(...args),
}));

const mockPublish = vi.fn();
vi.mock("@/lib/pi/session-events", () => ({
  publishSessionEvent: (...args: unknown[]) => mockPublish(...args),
}));

const mockWaitTeardown = vi.fn();
vi.mock("@/lib/pi/session-persistence", () => ({
  waitForPersistenceTeardown: (...args: unknown[]) => mockWaitTeardown(...args),
}));

const mockEnsureChatAgent = vi.fn();
const mockBeginChatRun = vi.fn();
const mockDispatchChatRun = vi.fn();
vi.mock("@/lib/chat/agent-run", () => ({
  ensureChatAgent: (...args: unknown[]) => mockEnsureChatAgent(...args),
  beginChatRun: (...args: unknown[]) => mockBeginChatRun(...args),
  dispatchChatRun: (...args: unknown[]) => mockDispatchChatRun(...args),
}));

import { respondInChat } from "@/lib/chat/respond-in-chat";

const USER_ID = "user-1";
const TARGET = "chat-2";
const CALLER = "chat-1";

const CHAT = {
  id: TARGET,
  userId: USER_ID,
  title: "Trip planning",
  modelProvider: null,
  modelName: null,
  thinkingLevel: "off",
  toolConfig: null,
};

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    promptInFlight: false,
    lastPromptedMessageId: null,
    session: { isStreaming: false, abort: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  };
}

describe("respondInChat", () => {
  let entry: ReturnType<typeof makeEntry>;

  beforeEach(() => {
    vi.clearAllMocks();
    entry = makeEntry();
    mockSessionFindFirst.mockResolvedValue(CHAT);
    mockResolveChatModel.mockResolvedValue({ provider: "anthropic", name: "claude-sonnet-4-5" });
    mockMessageCreate.mockResolvedValue({ id: "msg-1", createdAt: new Date() });
    mockMessageFindFirst.mockResolvedValue({ content: "Packed and ready." });
    mockSessionUpdate.mockResolvedValue({});
    mockPublish.mockResolvedValue(1);
    mockWaitTeardown.mockResolvedValue(undefined);
    mockIsSessionActive.mockResolvedValue(false);
    mockUnregister.mockResolvedValue(undefined);
    mockGetPoolEntry.mockReturnValue(undefined);
    mockEnsureChatAgent.mockResolvedValue({ entry, existedAlready: false });
    mockBeginChatRun.mockResolvedValue(undefined);
    mockDispatchChatRun.mockResolvedValue(true);
  });

  it("posts the message as the user, runs the chat, and returns its reply", async () => {
    const result = await respondInChat({
      userId: USER_ID,
      sessionId: TARGET,
      callerSessionId: CALLER,
      message: "  How did it go?  ",
    });

    expect(mockSessionFindFirst).toHaveBeenCalledWith({
      where: { id: TARGET, userId: USER_ID },
    });
    expect(mockMessageCreate).toHaveBeenCalledWith({
      data: { sessionId: TARGET, role: "user", content: "How did it go?" },
    });
    expect(mockEnsureChatAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        sessionId: TARGET,
        model: { provider: "anthropic", name: "claude-sonnet-4-5" },
      }),
    );
    expect(mockBeginChatRun).toHaveBeenCalledWith({
      userId: USER_ID,
      sessionId: TARGET,
      session: entry.session,
    });
    // The posted message must show up in a chat that is open elsewhere.
    expect(mockPublish).toHaveBeenCalledWith(TARGET, "messages_changed", {});
    expect(mockDispatchChatRun).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, sessionId: TARGET, content: "How did it go?" }),
    );
    // The reply is read only after persistence is guaranteed.
    expect(mockWaitTeardown).toHaveBeenCalledWith(TARGET);
    expect(result).toEqual({
      sessionId: TARGET,
      title: "Trip planning",
      reply: "Packed and ready.",
    });
  });

  it("refuses to respond in the caller's own chat", async () => {
    await expect(
      respondInChat({ userId: USER_ID, sessionId: CALLER, callerSessionId: CALLER, message: "hi" }),
    ).rejects.toThrow("A chat cannot respond to itself");
    expect(mockSessionFindFirst).not.toHaveBeenCalled();
  });

  it("rejects an empty message", async () => {
    await expect(
      respondInChat({ userId: USER_ID, sessionId: TARGET, message: "   " }),
    ).rejects.toThrow("message must not be empty");
    expect(mockSessionFindFirst).not.toHaveBeenCalled();
  });

  it("refuses a chat the user does not own", async () => {
    mockSessionFindFirst.mockResolvedValue(null);

    await expect(
      respondInChat({ userId: USER_ID, sessionId: "someone-elses", message: "hi" }),
    ).rejects.toThrow("Chat not found: someone-elses");
    expect(mockMessageCreate).not.toHaveBeenCalled();
    expect(mockDispatchChatRun).not.toHaveBeenCalled();
  });

  it("refuses a chat with no model configured", async () => {
    mockResolveChatModel.mockResolvedValue(undefined);

    await expect(
      respondInChat({ userId: USER_ID, sessionId: TARGET, message: "hi" }),
    ).rejects.toThrow('Chat "Trip planning" has no model configured');
    expect(mockMessageCreate).not.toHaveBeenCalled();
  });

  it("refuses a chat that is already generating", async () => {
    mockIsSessionActive.mockResolvedValue(true);

    await expect(
      respondInChat({ userId: USER_ID, sessionId: TARGET, message: "hi" }),
    ).rejects.toThrow('Chat "Trip planning" is busy');
    expect(mockMessageCreate).not.toHaveBeenCalled();
  });

  it("refuses when the pooled agent is mid-prompt", async () => {
    mockGetPoolEntry.mockReturnValue(makeEntry({ promptInFlight: true }));

    await expect(
      respondInChat({ userId: USER_ID, sessionId: TARGET, message: "hi" }),
    ).rejects.toThrow("is busy");
    expect(mockMessageCreate).not.toHaveBeenCalled();
  });

  it("reports a failed run and releases the claim", async () => {
    mockDispatchChatRun.mockResolvedValue(false);

    await expect(
      respondInChat({ userId: USER_ID, sessionId: TARGET, message: "hi" }),
    ).rejects.toThrow("failed to respond");

    // The chat must not look busy after a failed run.
    expect(entry.promptInFlight).toBe(false);
    expect(mockUnregister).toHaveBeenCalledWith(USER_ID, TARGET);
    expect(mockWaitTeardown).not.toHaveBeenCalled();
  });

  it("aborts the nested run when the caller is stopped", async () => {
    const controller = new AbortController();
    mockDispatchChatRun.mockImplementation(async () => {
      controller.abort();
      return true;
    });

    await respondInChat({
      userId: USER_ID,
      sessionId: TARGET,
      message: "hi",
      signal: controller.signal,
    });

    expect(entry.session.abort).toHaveBeenCalled();
  });
});
