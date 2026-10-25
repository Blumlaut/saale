import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockChatSession, mockAbortRequested, mockNotifyUser } = vi.hoisted(() => ({
  mockChatSession: { findFirst: vi.fn() },
  mockAbortRequested: vi.fn(),
  mockNotifyUser: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { chatSession: mockChatSession } }));
vi.mock("@/lib/pi/abort-request", () => ({
  wasSessionAbortRequested: (...args: unknown[]) => mockAbortRequested(...args),
}));
vi.mock("@/lib/notifications/notify", () => ({
  notifyUser: (...args: unknown[]) => mockNotifyUser(...args),
}));

const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

import { notifyChatFinished } from "@/lib/notifications/chat-finished";

const params = { userId: "user-1", sessionId: "chat-1" };

describe("chat finished notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAbortRequested.mockReturnValue(false);
    mockNotifyUser.mockResolvedValue(undefined);
    mockChatSession.findFirst.mockResolvedValue({
      title: "Weekly planning",
      temporary: false,
      projectId: null,
      project: null,
    });
  });

  it("notifies that a normal chat finished, opening that chat", async () => {
    await notifyChatFinished(params);

    expect(mockChatSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "chat-1", userId: "user-1" } }),
    );
    expect(mockNotifyUser).toHaveBeenCalledWith({
      userId: "user-1",
      category: "chatDone",
      title: "Finished responding",
      body: "Weekly planning",
      url: "/dashboard/chat/chat-1",
      tag: "chat-chat-1",
    });
  });

  it("uses the coder category and the project's chat page for a coder chat", async () => {
    mockChatSession.findFirst.mockResolvedValue({
      title: "Fix the flaky test",
      temporary: false,
      projectId: "project-1",
      project: { name: "saale" },
    });

    await notifyChatFinished(params);

    expect(mockNotifyUser).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "coderDone",
        title: "saale finished",
        body: "Fix the flaky test",
        url: "/dashboard/coder/project-1/chat-1",
      }),
    );
  });

  it("stays quiet when the user stopped the run themselves", async () => {
    mockAbortRequested.mockReturnValue(true);

    await notifyChatFinished(params);

    expect(mockNotifyUser).not.toHaveBeenCalled();
    expect(mockChatSession.findFirst).not.toHaveBeenCalled();
  });

  it("stays quiet for a temporary chat", async () => {
    mockChatSession.findFirst.mockResolvedValue({
      title: "Scratch",
      temporary: true,
      projectId: null,
      project: null,
    });

    await notifyChatFinished(params);

    expect(mockNotifyUser).not.toHaveBeenCalled();
  });

  it("stays quiet when the chat is gone", async () => {
    mockChatSession.findFirst.mockResolvedValue(null);

    await notifyChatFinished(params);

    expect(mockNotifyUser).not.toHaveBeenCalled();
  });

  it("never throws out of a finished run", async () => {
    mockChatSession.findFirst.mockRejectedValue(new Error("db down"));

    await expect(notifyChatFinished(params)).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
