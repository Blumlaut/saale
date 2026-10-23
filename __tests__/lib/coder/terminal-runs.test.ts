import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The terminal's runs, which belong to the chat rather than to a browser tab.
 *
 * What matters here: a command keeps running when its reader disconnects, what
 * it printed is replayed to the next reader, a second command waits for the
 * first, and a stop reaches the sandbox.
 */

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  kill: vi.fn(),
  registerTerminalExec: vi.fn(),
  unregisterTerminalExec: vi.fn(),
}));

vi.mock("@/lib/sandbox/client", () => ({ exec: mocks.exec, kill: mocks.kill }));
vi.mock("@/lib/redis", () => ({
  registerTerminalExec: mocks.registerTerminalExec,
  unregisterTerminalExec: mocks.unregisterTerminalExec,
}));

import {
  attachTerminalRun,
  beginTerminalRun,
  clearTerminalRun,
  forgetTerminalRun,
  stopTerminalRun,
  TerminalBusyError,
  type TerminalRunEvent,
} from "@/lib/coder/terminal-runs";

const USER = "user-1";
const SESSION = "chat-1";
const CWD = "/workspaces/user-user-1/worktrees/saale/c-1a2b3c4d";

type SandboxEvent =
  | { type: "started"; execId: string }
  | { type: "chunk"; stream: "stdout" | "stderr"; data: Buffer }
  | { type: "exit"; exitCode: number; timedOut: boolean; durationMs: number };

/** A sandbox exec a test drives by hand, the way the service streams one. */
interface FakeStream {
  iterator: AsyncGenerator<SandboxEvent>;
  push(event: SandboxEvent): void;
  fail(error: Error): void;
  end(): void;
}

function createStream(): FakeStream {
  const buffered: SandboxEvent[] = [];
  let failure: Error | null = null;
  let closed = false;
  let wake: (() => void) | null = null;

  const nudge = () => {
    const pending = wake;
    wake = null;
    pending?.();
  };

  async function* iterate(): AsyncGenerator<SandboxEvent> {
    for (;;) {
      if (buffered.length > 0) {
        yield buffered.shift() as SandboxEvent;
        continue;
      }
      if (failure) throw failure;
      if (closed) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }

  return {
    iterator: iterate(),
    push(event) {
      buffered.push(event);
      // The service ends the stream after the exit, the way its body ends.
      if (event.type === "exit") closed = true;
      nudge();
    },
    fail(error) {
      failure = error;
      nudge();
    },
    end() {
      closed = true;
      nudge();
    },
  };
}

let streams: FakeStream[] = [];

/** The stream the last command was started on. */
function current(): FakeStream {
  const last = streams[streams.length - 1];
  if (!last) throw new Error("no command was started");
  return last;
}

/** Watch a run for a moment and report where it has got to. */
async function watch(): Promise<{
  state: ReturnType<typeof attachTerminalRun>;
  events: TerminalRunEvent[];
}> {
  const events: TerminalRunEvent[] = [];
  const attachment = attachTerminalRun(USER, SESSION, (event) => events.push(event));
  return { state: attachment, events };
}

beforeEach(() => {
  vi.clearAllMocks();
  streams = [];
  mocks.exec.mockImplementation(() => {
    const stream = createStream();
    streams.push(stream);
    return stream.iterator;
  });
  mocks.kill.mockResolvedValue(undefined);
  mocks.registerTerminalExec.mockResolvedValue(undefined);
  mocks.unregisterTerminalExec.mockResolvedValue(undefined);
});

afterEach(() => {
  forgetTerminalRun(USER, SESSION);
  vi.restoreAllMocks();
});

describe("beginTerminalRun", () => {
  it("runs in the chat's worktree with stdin attached, and counts the command as running", () => {
    const state = beginTerminalRun({ userId: USER, sessionId: SESSION, cwd: CWD, command: "ls" });

    expect(mocks.exec).toHaveBeenCalledWith({
      identity: "user-user-1",
      command: "ls",
      cwd: CWD,
      interactive: true,
    });
    expect(state).toMatchObject({ command: "ls", status: "starting", execId: null });
  });

  it("writes the exec id down while the command runs, and forgets it at the end", async () => {
    beginTerminalRun({ userId: USER, sessionId: SESSION, cwd: CWD, command: "npm test" });

    current().push({ type: "started", execId: "exec-1" });
    await vi.waitFor(() =>
      expect(mocks.registerTerminalExec).toHaveBeenCalledWith(USER, SESSION, "exec-1"),
    );

    current().push({ type: "exit", exitCode: 0, timedOut: false, durationMs: 12 });
    await vi.waitFor(() =>
      expect(mocks.unregisterTerminalExec).toHaveBeenCalledWith(USER, SESSION, "exec-1"),
    );

    const { state } = await watch();
    expect(state?.state).toMatchObject({ status: "exited", exitCode: 0 });
    expect(state?.live).toBe(false);
  });

  it("refuses a second command while the first is still running", async () => {
    beginTerminalRun({ userId: USER, sessionId: SESSION, cwd: CWD, command: "npm run dev" });
    expect(() =>
      beginTerminalRun({ userId: USER, sessionId: SESSION, cwd: CWD, command: "ls" }),
    ).toThrow(TerminalBusyError);

    current().push({ type: "exit", exitCode: 0, timedOut: false, durationMs: 1 });
    await vi.waitFor(() => expect(attachTerminalRun(USER, SESSION, () => {})?.live).toBe(false));

    expect(() =>
      beginTerminalRun({ userId: USER, sessionId: SESSION, cwd: CWD, command: "ls" }),
    ).not.toThrow();
  });
});

describe("attachTerminalRun", () => {
  it("keeps the command running when its reader disconnects", async () => {
    beginTerminalRun({ userId: USER, sessionId: SESSION, cwd: CWD, command: "npm run dev" });
    current().push({ type: "started", execId: "exec-1" });
    current().push({ type: "chunk", stream: "stdout", data: Buffer.from("listening\n") });

    const first = await watch();
    await vi.waitFor(() =>
      expect(first.events.map((event) => event.type)).toEqual(["command", "started", "data"]),
    );
    first.state?.detach();

    // Nobody is watching: the dev server keeps printing.
    current().push({ type: "chunk", stream: "stdout", data: Buffer.from("401 GET /\n") });
    current().push({ type: "exit", exitCode: 143, timedOut: false, durationMs: 90_000 });
    await vi.waitFor(() => expect(mocks.unregisterTerminalExec).toHaveBeenCalled());

    const second = await watch();
    expect(second.events).toEqual([
      { type: "command", command: "npm run dev", startedAt: expect.any(Number) },
      { type: "started", execId: "exec-1" },
      // Merged into one segment: the buffer holds text, not chunk boundaries.
      { type: "data", stream: "stdout", text: "listening\n401 GET /\n" },
      { type: "exit", exitCode: 143, timedOut: false, durationMs: 90_000 },
    ]);
    expect(mocks.kill).not.toHaveBeenCalled();
  });

  it("holds half a character until the rest of it arrives", async () => {
    beginTerminalRun({ userId: USER, sessionId: SESSION, cwd: CWD, command: "printf é" });
    const bytes = Buffer.from("é");

    current().push({ type: "started", execId: "exec-1" });
    current().push({ type: "chunk", stream: "stdout", data: bytes.subarray(0, 1) });
    current().push({ type: "chunk", stream: "stdout", data: bytes.subarray(1) });
    current().push({ type: "exit", exitCode: 0, timedOut: false, durationMs: 1 });
    await vi.waitFor(() => expect(mocks.unregisterTerminalExec).toHaveBeenCalled());

    const { events } = await watch();
    const text = events
      .filter(
        (event): event is Extract<TerminalRunEvent, { type: "data" }> => event.type === "data",
      )
      .map((event) => event.text)
      .join("");
    expect(text).toBe("é");
  });

  it("reports a command that died without an exit code", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    beginTerminalRun({ userId: USER, sessionId: SESSION, cwd: CWD, command: "sleep 1" });
    current().push({ type: "started", execId: "exec-1" });

    current().fail(new Error("container went away"));
    await vi.waitFor(() =>
      expect(mocks.unregisterTerminalExec).toHaveBeenCalledWith(USER, SESSION, "exec-1"),
    );

    const { state, events } = await watch();
    expect(state?.state).toMatchObject({ status: "failed", error: "container went away" });
    expect(events).toContainEqual({ type: "error", message: "container went away" });
    expect(error).toHaveBeenCalled();
  });

  it("is null for a chat that never ran anything", () => {
    expect(attachTerminalRun(USER, "chat-other", () => {})).toBeNull();
  });
});

describe("stopTerminalRun", () => {
  it("signals the command the sandbox named", async () => {
    beginTerminalRun({ userId: USER, sessionId: SESSION, cwd: CWD, command: "npm run dev" });
    current().push({ type: "started", execId: "exec-1" });
    await vi.waitFor(() => expect(mocks.registerTerminalExec).toHaveBeenCalled());

    await expect(stopTerminalRun(USER, SESSION)).resolves.toBe(true);
    expect(mocks.kill).toHaveBeenCalledWith("exec-1");
  });

  it("kills a command that is stopped before the sandbox named it", async () => {
    beginTerminalRun({ userId: USER, sessionId: SESSION, cwd: CWD, command: "npm run dev" });

    await expect(stopTerminalRun(USER, SESSION)).resolves.toBe(true);
    expect(mocks.kill).not.toHaveBeenCalled();

    current().push({ type: "started", execId: "exec-1" });
    await vi.waitFor(() => expect(mocks.kill).toHaveBeenCalledWith("exec-1"));
  });

  it("has nothing to stop for a finished command", async () => {
    beginTerminalRun({ userId: USER, sessionId: SESSION, cwd: CWD, command: "true" });
    current().push({ type: "exit", exitCode: 0, timedOut: false, durationMs: 1 });
    await vi.waitFor(() => expect(attachTerminalRun(USER, SESSION, () => {})?.live).toBe(false));

    await expect(stopTerminalRun(USER, SESSION)).resolves.toBe(false);
    expect(mocks.kill).not.toHaveBeenCalled();
  });
});

describe("clearTerminalRun", () => {
  it("drops the output of a running command and keeps the command", async () => {
    beginTerminalRun({ userId: USER, sessionId: SESSION, cwd: CWD, command: "npm run dev" });
    const seen: TerminalRunEvent[] = [];
    attachTerminalRun(USER, SESSION, (event) => seen.push(event));

    current().push({ type: "started", execId: "exec-1" });
    current().push({ type: "chunk", stream: "stdout", data: Buffer.from("noise\n") });
    await vi.waitFor(() => expect(seen.some((event) => event.type === "data")).toBe(true));

    expect(clearTerminalRun(USER, SESSION)).toBe(true);

    const { state, events } = await watch();
    expect(state?.live).toBe(true);
    expect(events.filter((event) => event.type === "data")).toEqual([]);
  });

  it("forgets a finished run", async () => {
    beginTerminalRun({ userId: USER, sessionId: SESSION, cwd: CWD, command: "true" });
    current().push({ type: "exit", exitCode: 0, timedOut: false, durationMs: 1 });
    await vi.waitFor(() => expect(attachTerminalRun(USER, SESSION, () => {})?.live).toBe(false));

    expect(clearTerminalRun(USER, SESSION)).toBe(true);
    expect(attachTerminalRun(USER, SESSION, () => {})).toBeNull();
  });
});

describe("forgetTerminalRun", () => {
  it("ends the readers of a run whose worktree is going", async () => {
    beginTerminalRun({ userId: USER, sessionId: SESSION, cwd: CWD, command: "npm run dev" });
    current().push({ type: "started", execId: "exec-1" });
    const { events } = await watch();

    forgetTerminalRun(USER, SESSION);

    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(attachTerminalRun(USER, SESSION, () => {})).toBeNull();
  });
});
