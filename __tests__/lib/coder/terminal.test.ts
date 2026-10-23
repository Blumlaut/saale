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
  runTerminalCommand,
  sendTerminalInput,
  stopTerminalExecs,
  TerminalNotReadyError,
  type TerminalEvent,
  type TerminalTarget,
} from "@/lib/coder/terminal";

const USER = "user-1";
const SESSION = "chat-1";
const TARGET: TerminalTarget = {
  cwd: "/workspaces/user-user-1/worktrees/saale/c-1a2b3c4d",
  worktreePath: "worktrees/saale/c-1a2b3c4d",
  branch: "wt/c-1a2b3c4d",
};

/** An exec stream scripted as a list of events. */
function scriptedExec(events: Array<Record<string, unknown>>) {
  return async function* () {
    for (const event of events) yield event;
  };
}

async function collect(options: Parameters<typeof runTerminalCommand>[0]) {
  const collected: TerminalEvent[] = [];
  for await (const event of runTerminalCommand(options)) collected.push(event);
  return collected;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SANDBOX_WORKSPACES_DIR", "/workspaces");
  mocks.findChat.mockResolvedValue({
    coderWorktree: { path: TARGET.worktreePath, branch: TARGET.branch, status: "active" },
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
      select: { coderWorktree: { select: { path: true, branch: true, status: true } } },
    });
    expect(target).toEqual(TARGET);
  });

  it("is null for a chat that is not the caller's", async () => {
    mocks.findChat.mockResolvedValue(null);

    await expect(resolveTerminalTarget(USER, "chat-other")).resolves.toBeNull();
  });

  it("refuses a chat that has not built its worktree yet", async () => {
    mocks.findChat.mockResolvedValue({ coderWorktree: null });

    await expect(resolveTerminalTarget(USER, SESSION)).rejects.toBeInstanceOf(
      TerminalNotReadyError,
    );
  });

  it("refuses a worktree that was already removed", async () => {
    mocks.findChat.mockResolvedValue({
      coderWorktree: { path: TARGET.worktreePath, branch: TARGET.branch, status: "removed" },
    });

    await expect(resolveTerminalTarget(USER, SESSION)).rejects.toThrow(/no worktree yet/);
  });
});

describe("runTerminalCommand", () => {
  it("runs in the worktree with stdin, and writes the exec id down while it runs", async () => {
    mocks.exec.mockImplementation(
      scriptedExec([
        { type: "started", execId: "exec-1" },
        { type: "chunk", stream: "stdout", data: Buffer.from("hello\n") },
        { type: "exit", exitCode: 0, timedOut: false, durationMs: 42 },
      ]),
    );

    const events = await collect({ userId: USER, sessionId: SESSION, target: TARGET, command: "ls" });

    expect(mocks.exec).toHaveBeenCalledWith({
      identity: "user-user-1",
      command: "ls",
      cwd: TARGET.cwd,
      interactive: true,
    });
    expect(events).toEqual([
      { type: "started", execId: "exec-1" },
      { type: "data", stream: "stdout", text: "hello\n" },
      { type: "exit", exitCode: 0, timedOut: false, durationMs: 42 },
    ]);
    expect(mocks.registerTerminalExec).toHaveBeenCalledWith(USER, SESSION, "exec-1");
    expect(mocks.unregisterTerminalExec).toHaveBeenCalledWith(USER, SESSION, "exec-1");
  });

  it("keeps the two streams apart", async () => {
    mocks.exec.mockImplementation(
      scriptedExec([
        { type: "started", execId: "exec-1" },
        { type: "chunk", stream: "stdout", data: Buffer.from("out") },
        { type: "chunk", stream: "stderr", data: Buffer.from("err") },
        { type: "exit", exitCode: 1, timedOut: false, durationMs: 5 },
      ]),
    );

    const events = await collect({ userId: USER, sessionId: SESSION, target: TARGET, command: "x" });

    expect(events.filter((event) => event.type === "data")).toEqual([
      { type: "data", stream: "stdout", text: "out" },
      { type: "data", stream: "stderr", text: "err" },
    ]);
  });

  it("holds half a character until the rest of it arrives", async () => {
    // "é" is two bytes; a chunk boundary between them must not print garbage.
    const bytes = Buffer.from("é");
    mocks.exec.mockImplementation(
      scriptedExec([
        { type: "started", execId: "exec-1" },
        { type: "chunk", stream: "stdout", data: bytes.subarray(0, 1) },
        { type: "chunk", stream: "stdout", data: bytes.subarray(1) },
        { type: "exit", exitCode: 0, timedOut: false, durationMs: 1 },
      ]),
    );

    const events = await collect({ userId: USER, sessionId: SESSION, target: TARGET, command: "x" });
    const text = events
      .filter((event): event is Extract<TerminalEvent, { type: "data" }> => event.type === "data")
      .map((event) => event.text)
      .join("");

    expect(text).toBe("é");
  });

  it("forgets the command when the run fails partway", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.exec.mockImplementation(async function* () {
      yield { type: "started", execId: "exec-1" };
      throw new Error("container went away");
    });

    await expect(
      collect({ userId: USER, sessionId: SESSION, target: TARGET, command: "sleep 1" }),
    ).rejects.toThrow(/container went away/);
    expect(mocks.unregisterTerminalExec).toHaveBeenCalledWith(USER, SESSION, "exec-1");
    error.mockRestore();
  });
});

describe("sendTerminalInput", () => {
  it("passes keystrokes to the sandbox for a command this chat is running", async () => {
    mocks.getTerminalExecs.mockResolvedValue(new Set(["exec-1"]));

    await sendTerminalInput({ userId: USER, sessionId: SESSION, execId: "exec-1", data: "y\n" });

    expect(mocks.writeInput).toHaveBeenCalledWith("exec-1", "user-user-1", "y\n");
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
