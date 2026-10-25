import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Dispatching a fire into a project.
 *
 * What matters here is that a bot chat is an ordinary coder chat: the project is
 * checked against its owner, the row carries where it came from, the branch
 * names the watcher, and the turn goes through the same `respondInChat` a
 * person's message does.
 */

const CHAT_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

vi.mock("@/lib/db", () => ({
  prisma: {
    coderProject: { findFirst: vi.fn() },
    chatSession: { findFirst: vi.fn(), findMany: vi.fn() },
    scriptWatcher: { update: vi.fn() },
  },
}));

vi.mock("@/lib/redis", () => ({ getActiveSessions: vi.fn() }));

vi.mock("@/lib/chat/respond-in-chat", () => ({ respondInChat: vi.fn() }));

vi.mock("@/lib/chat/create-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chat/create-session")>();
  return { ...actual, createChatSessionRow: vi.fn() };
});

import { prisma } from "@/lib/db";
import { getActiveSessions } from "@/lib/redis";
import { respondInChat } from "@/lib/chat/respond-in-chat";
import { createChatSessionRow } from "@/lib/chat/create-session";
import { dispatchWatcherRun, fireBranch, fireTitle } from "@/lib/coder/dispatch";

/* eslint-disable @typescript-eslint/no-explicit-any */
const findProject = vi.mocked(prisma.coderProject.findFirst as any);
const findChat = vi.mocked(prisma.chatSession.findFirst as any);
const findChats = vi.mocked(prisma.chatSession.findMany as any);
const activeSessions = vi.mocked(getActiveSessions as any);
const updateWatcher = vi.mocked(prisma.scriptWatcher.update as any);
const respond = vi.mocked(respondInChat as any);
const createChat = vi.mocked(createChatSessionRow as any);
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Dispatch a fire for the per-fire watcher every case here uses. */
function fire() {
  return dispatchWatcherRun({
    userId: "u-1",
    watcher: {
      id: "w-1",
      name: "PR bot",
      projectId: "project-1",
      worktreeMode: "per-fire",
      stickySessionId: null,
    },
    modelId: null,
    message: "Review it",
    value: { number: 42 },
  });
}

/** The data of the chat row created, if one was. */
function createdChat(): Record<string, unknown> | undefined {
  return createChat.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
}

describe("fireTitle", () => {
  it("reads the fire's value into the title so chats are told apart", () => {
    expect(
      fireTitle({ name: "PR bot", value: { number: 42, title: "Fix login", draft: false } }),
    ).toBe("PR bot: number: 42, title: Fix login");
  });

  it("falls back to the watcher's name for a bare signal", () => {
    expect(fireTitle({ name: "PR bot", value: true })).toBe("PR bot: true");
  });

  it("keeps a long value inside a chat title", () => {
    expect(fireTitle({ name: "PR bot", value: "x".repeat(200) }).length).toBeLessThanOrEqual(50);
  });

  it("still names the chat when the value cannot be read", () => {
    expect(fireTitle({ name: "PR bot", value: undefined })).toBe("PR bot");
  });
});

describe("fireBranch", () => {
  it("names a per-fire branch after the watcher and the fire", () => {
    expect(
      fireBranch({ watcherName: "Review pull requests", sessionId: CHAT_ID, mode: "per-fire" }),
    ).toBe("watch/review-pull-requests/c-3f2504e0");
  });

  it("gives a sticky watcher one branch for the whole thread", () => {
    expect(
      fireBranch({ watcherName: "Review pull requests", sessionId: CHAT_ID, mode: "sticky" }),
    ).toBe("watch/review-pull-requests/sticky");
  });
});

describe("dispatchWatcherRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("crypto", { randomUUID: () => CHAT_ID });
    findProject.mockResolvedValue({ id: "project-1" });
    findChat.mockResolvedValue(null);
    findChats.mockResolvedValue([]);
    activeSessions.mockResolvedValue(new Set<string>());
    createChat.mockImplementation(async (userId: string, input: Record<string, unknown>) => ({
      id: input.id,
      title: input.title,
      createdAt: new Date("2026-01-01"),
    }));
    respond.mockResolvedValue({
      sessionId: CHAT_ID,
      title: "PR bot",
      reply: "looked at it",
      answered: true,
      error: null,
    });
    updateWatcher.mockResolvedValue({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens a coder chat in its own worktree and runs the turn there", async () => {
    const result = await dispatchWatcherRun({
      userId: "u-1",
      watcher: {
        id: "w-1",
        name: "PR bot",
        projectId: "project-1",
        worktreeMode: "per-fire",
        stickySessionId: null,
      },
      modelId: null,
      message: "Review it",
      value: { number: 42 },
    });

    expect(result.sessionId).toBe(CHAT_ID);
    expect(createdChat()).toMatchObject({
      id: CHAT_ID,
      projectId: "project-1",
      origin: "watcher",
      originId: "w-1",
      worktreeBranch: "watch/pr-bot/c-3f2504e0",
    });
    // No model named, so the chat resolves the user's default when it runs.
    expect(createdChat()?.modelProvider).toBeUndefined();
    expect(respond).toHaveBeenCalledWith({
      userId: "u-1",
      sessionId: CHAT_ID,
      message: "Review it",
    });
  });

  it("gives the chat the model the watcher names", async () => {
    await dispatchWatcherRun({
      userId: "u-1",
      watcher: {
        id: "w-1",
        name: "PR bot",
        projectId: "project-1",
        worktreeMode: "per-fire",
        stickySessionId: null,
      },
      modelId: "anthropic:claude-sonnet-4",
      message: "Review it",
      value: { number: 42 },
    });

    expect(createdChat()?.modelProvider).toBe("anthropic");
    expect(createdChat()?.modelName).toBe("claude-sonnet-4");
  });

  it("reuses the chat a sticky watcher already has", async () => {
    findChat.mockResolvedValue({ id: "chat-9" });

    const result = await dispatchWatcherRun({
      userId: "u-1",
      watcher: {
        id: "w-1",
        name: "PR bot",
        projectId: "project-1",
        worktreeMode: "sticky",
        stickySessionId: "chat-9",
      },
      modelId: null,
      message: "Follow up",
      value: { number: 42 },
    });

    expect(result.sessionId).toBe("chat-9");
    expect(createChat).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "chat-9", message: "Follow up" }),
    );
  });

  it("makes a sticky chat when the one it kept is gone, and remembers the new one", async () => {
    findChat.mockResolvedValue(null);

    const result = await dispatchWatcherRun({
      userId: "u-1",
      watcher: {
        id: "w-1",
        name: "PR bot",
        projectId: "project-1",
        worktreeMode: "sticky",
        stickySessionId: "deleted-chat",
      },
      modelId: null,
      message: "Review it",
      value: { number: 42 },
    });

    expect(result.sessionId).toBe(CHAT_ID);
    expect(createdChat()?.worktreeBranch).toBe("watch/pr-bot/sticky");
    expect(updateWatcher).toHaveBeenCalledWith({
      where: { id: "w-1" },
      data: { stickySessionId: CHAT_ID },
    });
  });

  it("refuses a fire while a previous fire is still running", async () => {
    activeSessions.mockResolvedValue(new Set(["chat-running"]));
    findChats.mockResolvedValue([{ id: "chat-running" }]);

    await expect(
      dispatchWatcherRun({
        userId: "u-1",
        watcher: {
          id: "w-1",
          name: "PR bot",
          projectId: "project-1",
          worktreeMode: "per-fire",
          stickySessionId: null,
        },
        modelId: null,
        message: "Review it",
        value: { number: 42 },
      }),
    ).rejects.toThrow(/still working in chat chat-running/);

    expect(createChat).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  it("does not go looking for its chats when nothing is generating", async () => {
    await dispatchWatcherRun({
      userId: "u-1",
      watcher: {
        id: "w-1",
        name: "PR bot",
        projectId: "project-1",
        worktreeMode: "per-fire",
        stickySessionId: null,
      },
      modelId: null,
      message: "Review it",
      value: { number: 42 },
    });

    expect(findChats).not.toHaveBeenCalled();
  });

  it("refuses a run that left no turn behind", async () => {
    respond.mockResolvedValue({
      sessionId: CHAT_ID,
      title: "PR bot",
      reply: "",
      answered: false,
      error: null,
    });

    await expect(fire()).rejects.toThrow(/finished without an assistant turn/);
  });

  it("carries the provider's error out of a failed run", async () => {
    respond.mockResolvedValue({
      sessionId: CHAT_ID,
      title: "PR bot",
      reply: "",
      answered: true,
      error: "429: rate limit exceeded",
    });

    await expect(fire()).rejects.toThrow(/429: rate limit exceeded/);
  });

  it("refuses a project that is not the watcher owner's", async () => {
    findProject.mockResolvedValue(null);

    await expect(
      dispatchWatcherRun({
        userId: "u-1",
        watcher: {
          id: "w-1",
          name: "PR bot",
          projectId: "someone-elses",
          worktreeMode: "per-fire",
          stickySessionId: null,
        },
        modelId: null,
        message: "Review it",
        value: { number: 42 },
      }),
    ).rejects.toThrow(/project is gone/);

    expect(findProject).toHaveBeenCalledWith({
      where: { id: "someone-elses", userId: "u-1" },
      select: { id: true },
    });
    expect(respond).not.toHaveBeenCalled();
  });
});
