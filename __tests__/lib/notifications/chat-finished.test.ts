import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockChatSession, mockAbortRequested, mockNotifyUser, mockWaitTeardown, mockGetChatSeenAt } =
  vi.hoisted(() => ({
    mockChatSession: { findFirst: vi.fn() },
    mockAbortRequested: vi.fn(),
    mockNotifyUser: vi.fn(),
    mockWaitTeardown: vi.fn(),
    mockGetChatSeenAt: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({ prisma: { chatSession: mockChatSession } }));
vi.mock("@/lib/pi/abort-request", () => ({
  wasSessionAbortRequested: (...args: unknown[]) => mockAbortRequested(...args),
}));
vi.mock("@/lib/pi/session-persistence", () => ({
  waitForPersistenceTeardown: (...args: unknown[]) => mockWaitTeardown(...args),
}));
vi.mock("@/lib/redis", () => ({
  getChatSeenAt: (...args: unknown[]) => mockGetChatSeenAt(...args),
}));
vi.mock("@/lib/notifications/notify", () => ({
  notifyUser: (...args: unknown[]) => mockNotifyUser(...args),
}));

const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

import { notifyChatFinished } from "@/lib/notifications/chat-finished";

const params = { userId: "user-1", sessionId: "chat-1" };

/** The notification path waits out a grace period before sending. */
async function notify(): Promise<void> {
  const pending = notifyChatFinished(params);
  await vi.runAllTimersAsync();
  await pending;
}

describe("chat finished notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockAbortRequested.mockReturnValue(false);
    mockGetChatSeenAt.mockResolvedValue(null);
    mockNotifyUser.mockResolvedValue(undefined);
    mockWaitTeardown.mockResolvedValue(undefined);
    mockChatSession.findFirst.mockResolvedValue({
      title: "Weekly planning",
      temporary: false,
      projectId: null,
      project: null,
      messages: [{ content: "Here is the plan for the week ahead." }],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("notifies that a normal chat finished, opening that chat", async () => {
    await notify();

    expect(mockWaitTeardown).toHaveBeenCalledWith("chat-1");
    expect(mockChatSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "chat-1", userId: "user-1" } }),
    );
    expect(mockNotifyUser).toHaveBeenCalledWith({
      userId: "user-1",
      category: "chatDone",
      title: "Finished responding",
      body: "Here is the plan for the week ahead.",
      url: "/dashboard/chat/chat-1",
      tag: "chat-chat-1",
    });
  });

  it("flattens the reply and cuts a long one", async () => {
    mockChatSession.findFirst.mockResolvedValue({
      title: "Weekly planning",
      temporary: false,
      projectId: null,
      project: null,
      messages: [{ content: `# Plan\n\n- ${"item ".repeat(60)}` }],
    });

    await notify();

    const body = mockNotifyUser.mock.calls[0]?.[0].body as string;
    expect(body.startsWith("# Plan - item item")).toBe(true);
    expect(body.endsWith("…")).toBe(true);
    expect(body.length).toBeLessThanOrEqual(120);
  });

  it("falls back to the chat title when the reply is empty", async () => {
    mockChatSession.findFirst.mockResolvedValue({
      title: "Weekly planning",
      temporary: false,
      projectId: null,
      project: null,
      messages: [{ content: "   " }],
    });

    await notify();

    expect(mockNotifyUser).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Weekly planning" }),
    );
  });

  it("falls back to the chat title when the chat has no reply yet", async () => {
    mockChatSession.findFirst.mockResolvedValue({
      title: "Weekly planning",
      temporary: false,
      projectId: null,
      project: null,
      messages: [],
    });

    await notify();

    expect(mockNotifyUser).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Weekly planning" }),
    );
  });

  it("uses the coder category and the project's chat page for a coder chat", async () => {
    mockChatSession.findFirst.mockResolvedValue({
      title: "Fix the flaky test",
      temporary: false,
      projectId: "project-1",
      project: { name: "saale" },
      messages: [{ content: "Fixed it: the worker was reused across tests." }],
    });

    await notify();

    expect(mockNotifyUser).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "coderDone",
        title: "saale finished",
        body: "Fixed it: the worker was reused across tests.",
        url: "/dashboard/coder/project-1/chat-1",
      }),
    );
  });

  it("stays quiet when the user stopped the run themselves", async () => {
    mockAbortRequested.mockReturnValue(true);

    await notify();

    expect(mockNotifyUser).not.toHaveBeenCalled();
    expect(mockWaitTeardown).not.toHaveBeenCalled();
    expect(mockChatSession.findFirst).not.toHaveBeenCalled();
  });

  it("stays quiet for a temporary chat", async () => {
    mockChatSession.findFirst.mockResolvedValue({
      title: "Scratch",
      temporary: true,
      projectId: null,
      project: null,
      messages: [{ content: "Temporary answer" }],
    });

    await notify();

    expect(mockNotifyUser).not.toHaveBeenCalled();
  });

  it("stays quiet when the chat is gone", async () => {
    mockChatSession.findFirst.mockResolvedValue(null);

    await notify();

    expect(mockNotifyUser).not.toHaveBeenCalled();
  });

  it("never throws out of a finished run", async () => {
    mockChatSession.findFirst.mockRejectedValue(new Error("db down"));

    await expect(notify()).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("stays quiet when the reply landed on a screen the user was looking at", async () => {
    mockGetChatSeenAt.mockResolvedValue(Date.now() + 200);

    await notify();

    expect(mockGetChatSeenAt).toHaveBeenCalledWith("user-1", "chat-1");
    expect(mockNotifyUser).not.toHaveBeenCalled();
  });

  it("notifies when the chat was last on screen before the turn finished", async () => {
    mockGetChatSeenAt.mockResolvedValue(Date.now() - 60_000);

    await notify();

    expect(mockNotifyUser).toHaveBeenCalled();
  });

  it("reads what the user has seen after the grace period, not before it", async () => {
    const pending = notifyChatFinished(params);
    expect(mockGetChatSeenAt).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    await pending;

    expect(mockGetChatSeenAt).toHaveBeenCalledWith("user-1", "chat-1");
  });
});
