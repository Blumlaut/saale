import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The terminal panel's server side.
 *
 * What matters here: a command runs in the chat's own worktree, its exec id is
 * written down while it runs so cleanup can stop it, and the next keystroke
 * reaches the sandbox only while that command is still there.
 */

const mocks = vi.hoisted(() => ({
  findChat: vi.fn(),
  exec: vi.fn(),
  kill: vi.fn(),
  writeInput: vi.fn(),
  registerTerminalExec: vi.fn(),
  unregisterTerminalExec: vi.fn(),
  getTerminalExecs: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { chatSession: { findFirst: mocks.findChat } } }));
vi.mock("@/lib/sandbox/client", () => ({
  exec: mocks.exec,
  kill: mocks.kill,
  writeInput: mocks.writeInput,
}));
vi.mock("@/lib/redis", () => ({
  registerTerminalExec: mocks.registerTerminalExec,
  unregisterTerminalExec: mocks.unregisterTerminalExec,
  getTerminalExecs: mocks.getTerminalExecs,
}));

import {
  resolveTerminalTarget,
  sendTerminalInput,
  stopTerminalExecs,
  TerminalNotReadyError,
  type TerminalTarget,
} from "@/lib/coder/terminal";
import { userIdentity } from "@/lib/sandbox/identity";

const USER = "user-1";
const SESSION = "chat-1";
const IDENTITY = userIdentity(USER);
const TARGET: TerminalTarget = {
  cwd: `/workspaces/${IDENTITY}/worktrees/saale/c-1a2b3c4d`,
  worktreePath: "worktrees/saale/c-1a2b3c4d",
  branch: "wt/c-1a2b3c4d",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SANDBOX_WORKSPACES_DIR", "/workspaces");
  mocks.findChat.mockResolvedValue({
    project: { repoPath: "projects/saale", chatMode: "worktree" },
    coderWorktree: {
      path: TARGET.worktreePath,
      branch: TARGET.branch,
      baseSha: "abc1234",
      status: "active",
    },
  });
  mocks.registerTerminalExec.mockResolvedValue(undefined);
  mocks.unregisterTerminalExec.mockResolvedValue(undefined);
  mocks.getTerminalExecs.mockResolvedValue(new Set<string>());
  mocks.writeInput.mockResolvedValue(undefined);
  mocks.kill.mockResolvedValue(undefined);
});

describe("resolveTerminalTarget", () => {
  it("resolves the chat's worktree to a path inside its container", async () => {
    const target = await resolveTerminalTarget(USER, SESSION);

    expect(mocks.findChat).toHaveBeenCalledWith({
      where: { id: SESSION, userId: USER, projectId: { not: null } },
      select: {
        project: { select: { repoPath: true, chatMode: true } },
        coderWorktree: { select: { path: true, branch: true, baseSha: true, status: true } },
      },
    });
    expect(target).toEqual(TARGET);
  });

  it("is null for a chat that is not the caller's", async () => {
    mocks.findChat.mockResolvedValue(null);

    await expect(resolveTerminalTarget(USER, "chat-other")).resolves.toBeNull();
  });

  it("refuses a chat that has not built its worktree yet", async () => {
    mocks.findChat.mockResolvedValue({
      project: { repoPath: "projects/saale", chatMode: "worktree" },
      coderWorktree: null,
    });

    await expect(resolveTerminalTarget(USER, SESSION)).rejects.toBeInstanceOf(
      TerminalNotReadyError,
    );
  });

  it("refuses a worktree that was already removed", async () => {
    mocks.findChat.mockResolvedValue({
      project: { repoPath: "projects/saale", chatMode: "worktree" },
      coderWorktree: {
        path: TARGET.worktreePath,
        branch: TARGET.branch,
        baseSha: "abc1234",
        status: "removed",
      },
    });

    await expect(resolveTerminalTarget(USER, SESSION)).rejects.toThrow(/no worktree yet/);
  });

  it("runs in the project's own checkout when chats share it", async () => {
    mocks.findChat.mockResolvedValue({
      project: { repoPath: "projects/saale", chatMode: "repo" },
      coderWorktree: null,
    });

    await expect(resolveTerminalTarget(USER, SESSION)).resolves.toEqual({
      cwd: `/workspaces/${IDENTITY}/projects/saale`,
      worktreePath: "projects/saale",
      branch: "",
    });
  });
});

describe("sendTerminalInput", () => {
  it("passes keystrokes to the sandbox for a command this chat is running", async () => {
    mocks.getTerminalExecs.mockResolvedValue(new Set(["exec-1"]));

    await sendTerminalInput({ userId: USER, sessionId: SESSION, execId: "exec-1", data: "y\n" });

    expect(mocks.writeInput).toHaveBeenCalledWith("exec-1", IDENTITY, "y\n");
  });

  it("refuses an exec id this chat never started", async () => {
    mocks.getTerminalExecs.mockResolvedValue(new Set(["exec-1"]));

    await expect(
      sendTerminalInput({ userId: USER, sessionId: SESSION, execId: "exec-9", data: "x" }),
    ).rejects.toThrow(/not running/);
    expect(mocks.writeInput).not.toHaveBeenCalled();
  });
});

describe("stopTerminalExecs", () => {
  it("stops each running command and clears it from the chat's list", async () => {
    mocks.getTerminalExecs.mockResolvedValue(new Set(["exec-1", "exec-2"]));

    await expect(stopTerminalExecs(USER, SESSION)).resolves.toBe(2);

    expect(mocks.kill.mock.calls.map(([id]) => id)).toEqual(["exec-1", "exec-2"]);
    expect(mocks.unregisterTerminalExec).toHaveBeenCalledTimes(2);
  });

  it("counts only the commands it could stop", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getTerminalExecs.mockResolvedValue(new Set(["exec-1", "exec-2"]));
    mocks.kill.mockRejectedValueOnce(new Error("No running command exec-1"));

    await expect(stopTerminalExecs(USER, SESSION)).resolves.toBe(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("does nothing for a chat with no terminal", async () => {
    await expect(stopTerminalExecs(USER, SESSION)).resolves.toBe(0);
    expect(mocks.kill).not.toHaveBeenCalled();
  });
});
