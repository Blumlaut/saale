import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Killing what a deleted chat left running.
 *
 * The sweep is the last thing that can reach a dev server whose chat row is
 * gone, so what it gets right is which ids it treats as gone, and that it never
 * reaches into another account's container.
 */

const mocks = vi.hoisted(() => ({
  findProjects: vi.fn(),
  findChats: vi.fn(),
  canExec: vi.fn(),
  listRunningChatIds: vi.fn(),
  stopChatProcessesById: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    coderProject: { findMany: mocks.findProjects },
    chatSession: { findMany: mocks.findChats },
  },
}));

vi.mock("@/lib/sandbox/client", () => ({ canExec: mocks.canExec }));

vi.mock("@/lib/coder/processes", () => ({
  listRunningChatIds: mocks.listRunningChatIds,
  stopChatProcessesById: mocks.stopChatProcessesById,
}));

import { sweepOrphanProcesses } from "@/lib/coder/process-sweep";

const USER = "user-1";
const OTHER_USER = "user-2";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findProjects.mockResolvedValue([{ userId: USER }]);
  mocks.findChats.mockResolvedValue([]);
  mocks.canExec.mockReturnValue(true);
  mocks.listRunningChatIds.mockResolvedValue([]);
  mocks.stopChatProcessesById.mockResolvedValue(undefined);
});

describe("sweepOrphanProcesses", () => {
  it("stops the processes of an id no chat answers to and leaves a live chat alone", async () => {
    mocks.listRunningChatIds.mockResolvedValue(["chat-live", "chat-deleted"]);
    mocks.findChats.mockResolvedValue([{ id: "chat-live" }]);

    const result = await sweepOrphanProcesses();

    expect(result).toEqual({ stopped: ["chat-deleted"], live: 1 });
    expect(mocks.stopChatProcessesById).toHaveBeenCalledTimes(1);
    expect(mocks.stopChatProcessesById).toHaveBeenCalledWith(USER, "chat-deleted");
  });

  it("asks only for the chats the user owns", async () => {
    mocks.listRunningChatIds.mockResolvedValue(["chat-live"]);

    await sweepOrphanProcesses();

    expect(mocks.findChats).toHaveBeenCalledWith({
      where: { userId: USER, id: { in: ["chat-live"] } },
      select: { id: true },
    });
  });

  it("takes a chat of another account as gone", async () => {
    mocks.findProjects.mockResolvedValue([{ userId: OTHER_USER }]);
    mocks.listRunningChatIds.mockResolvedValue(["chat-of-user-1"]);
    mocks.findChats.mockResolvedValue([]);

    const result = await sweepOrphanProcesses();

    expect(result.stopped).toEqual(["chat-of-user-1"]);
    expect(mocks.stopChatProcessesById).toHaveBeenCalledWith(OTHER_USER, "chat-of-user-1");
  });

  it("carries on with the next user when one container cannot be read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.findProjects.mockResolvedValue([{ userId: USER }, { userId: OTHER_USER }]);
    mocks.listRunningChatIds
      .mockRejectedValueOnce(new Error("no such container"))
      .mockResolvedValueOnce(["chat-deleted"]);

    const result = await sweepOrphanProcesses();

    expect(result.stopped).toEqual(["chat-deleted"]);
    expect(mocks.stopChatProcessesById).toHaveBeenCalledWith(OTHER_USER, "chat-deleted");
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("reports a chat it could not stop and still counts the rest", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.listRunningChatIds.mockResolvedValue(["chat-a", "chat-b"]);
    mocks.stopChatProcessesById
      .mockRejectedValueOnce(new Error("sandbox is down"))
      .mockResolvedValueOnce(undefined);

    const result = await sweepOrphanProcesses();

    expect(result.stopped).toEqual(["chat-b"]);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("does nothing at all without a sandbox to ask", async () => {
    mocks.canExec.mockReturnValue(false);

    const result = await sweepOrphanProcesses();

    expect(result).toEqual({ stopped: [], live: 0 });
    expect(mocks.findProjects).not.toHaveBeenCalled();
    expect(mocks.listRunningChatIds).not.toHaveBeenCalled();
  });

  it("skips a user with nothing running", async () => {
    const result = await sweepOrphanProcesses();

    expect(result).toEqual({ stopped: [], live: 0 });
    expect(mocks.findChats).not.toHaveBeenCalled();
  });
});
