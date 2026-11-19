import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { infraMachine: { findFirst: vi.fn() } },
}));

vi.mock("@/lib/sandbox/client", () => ({
  canExec: vi.fn(() => true),
  exec: vi.fn(),
  kill: vi.fn(async () => undefined),
  resize: vi.fn(async () => undefined),
  writeInput: vi.fn(async () => undefined),
}));

vi.mock("@/lib/sandbox/identity", () => ({
  userIdentity: (userId: string) => `user-${userId}`,
}));

vi.mock("@/lib/sandbox/workspace", () => ({
  ensureWorkspace: vi.fn(async () => "/w/user-u1"),
}));

vi.mock("@/lib/infra/client", () => ({
  openShellChannel: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { openShellChannel } from "@/lib/infra/client";
import { canExec, exec, kill, resize, writeInput } from "@/lib/sandbox/client";
import {
  attachShell,
  closeShell,
  sendShellInput,
  ShellUnavailableError,
  startShell,
  type ShellEvent,
} from "@/lib/terminal/shell-sessions";

const USER = "u1";

/** A workspace shell that prints a prompt and then waits to be told to stop. */
function holdShellOpen() {
  let finish: (() => void) | null = null;
  vi.mocked(exec).mockImplementation(() => {
    return (async function* () {
      yield { type: "started" as const, execId: "exec-1" };
      yield { type: "chunk" as const, stream: "stdout" as const, data: Buffer.from("$ ") };
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    })();
  });
  return () => finish?.();
}

/** Collect everything a reader is told, until the shell closes. */
function collect(): { events: ShellEvent[]; stop: () => void } {
  const events: ShellEvent[] = [];
  const attachment = attachShell(USER, "user", (event) => events.push(event));
  return {
    events,
    stop: () => attachment?.detach(),
  };
}

describe("shell sessions", () => {
  beforeEach(() => {
    closeShell(USER, "user");
    closeShell(USER, "machine:m1");
    vi.mocked(canExec).mockReturnValue(true);
    vi.mocked(prisma.infraMachine.findFirst).mockReset();
    vi.mocked(openShellChannel).mockReset();
  });

  it("opens a shell in the user's workspace and streams what it prints", async () => {
    const stop = holdShellOpen();

    await startShell(USER, "user");
    // The reader arrives after the shell, which is how the panel attaches.
    const reader = collect();
    await vi.waitFor(() => expect(reader.events.some((e) => e.type === "output")).toBe(true));

    expect(reader.events).toContainEqual({ type: "output", text: "$ " });
    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: "user-u1",
        cwd: "/w/user-u1",
        command: "bash",
        interactive: true,
        tty: true,
      }),
    );

    stop();
    reader.stop();
  });

  it("types into the running shell and resizes it", async () => {
    const stop = holdShellOpen();
    await startShell(USER, "user");
    const reader = collect();
    await vi.waitFor(() => expect(reader.events.length).toBeGreaterThan(0));

    expect(sendShellInput(USER, "user", "ls\r")).toBe(true);
    await vi.waitFor(() =>
      expect(writeInput).toHaveBeenCalledWith("exec-1", "user-u1", Buffer.from("ls\r")),
    );

    expect(reader.events).not.toHaveLength(0);
    reader.stop();
    stop();
  });

  it("replays what the shell printed to a reader that comes back", async () => {
    const stop = holdShellOpen();
    await startShell(USER, "user");
    const first = collect();
    await vi.waitFor(() => expect(first.events.length).toBeGreaterThan(0));
    first.stop();

    const second = collect();
    await vi.waitFor(() => expect(second.events.length).toBeGreaterThan(0));
    expect(second.events[0]).toEqual({ type: "output", text: "$ " });

    second.stop();
    stop();
  });

  it("kills the command when the shell is closed", async () => {
    const stop = holdShellOpen();
    await startShell(USER, "user");
    const reader = collect();
    await vi.waitFor(() => expect(reader.events.length).toBeGreaterThan(0));

    expect(closeShell(USER, "user")).toBe(true);
    await vi.waitFor(() => expect(kill).toHaveBeenCalledWith("exec-1"));
    // The reader is told the shell ended, so its stream does not wait forever.
    expect(reader.events).toContainEqual({ type: "closed", error: null });

    reader.stop();
    stop();
  });

  it("resizes a shell that is asked to", async () => {
    const stop = holdShellOpen();
    await startShell(USER, "user");
    const reader = collect();
    await vi.waitFor(() => expect(reader.events.length).toBeGreaterThan(0));

    const { resizeShell } = await import("@/lib/terminal/shell-sessions");
    expect(resizeShell(USER, "user", 120, 40)).toBe(true);
    expect(resize).toHaveBeenCalledWith("exec-1", 120, 40, "user-u1");

    reader.stop();
    stop();
  });

  it("refuses a deployment that cannot run commands", async () => {
    vi.mocked(canExec).mockReturnValue(false);

    await expect(startShell(USER, "user")).rejects.toBeInstanceOf(ShellUnavailableError);
  });

  it("refuses a target it does not know", async () => {
    await expect(startShell(USER, "elsewhere:/")).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a machine that is not the caller's", async () => {
    vi.mocked(prisma.infraMachine.findFirst).mockResolvedValue(null);

    await expect(startShell(USER, "machine:m1")).rejects.toMatchObject({ status: 404 });
    expect(openShellChannel).not.toHaveBeenCalled();
  });

  it("starts a new shell once the last one exited", async () => {
    const stop = holdShellOpen();
    const first = await startShell(USER, "user");
    const reader = collect();
    await vi.waitFor(() => expect(reader.events.length).toBeGreaterThan(0));
    reader.stop();
    stop();
    await vi.waitFor(() => expect(attachShell(USER, "user", () => {})?.live).toBe(false));

    const stopAgain = holdShellOpen();
    const second = await startShell(USER, "user");

    expect(second.status).not.toBe("closed");
    expect(attachShell(USER, "user", () => {})?.state.target).toBe(first.target);
    stopAgain();
  });

  it("closes a machine's channel that arrived after the shell was closed", async () => {
    vi.mocked(prisma.infraMachine.findFirst).mockResolvedValue({ id: "m1" } as never);
    let open: (value: unknown) => void = () => {};
    vi.mocked(openShellChannel).mockReturnValue(
      new Promise((resolve) => {
        open = resolve as (value: unknown) => void;
      }),
    );
    const closed = vi.fn();

    await startShell(USER, "machine:m1");
    closeShell(USER, "machine:m1");

    open({ write: () => undefined, resize: () => undefined, close: closed });
    await vi.waitFor(() => expect(closed).toHaveBeenCalled());
    expect(attachShell(USER, "machine:m1", () => {})).toBeNull();
  });

  it("opens an SSH shell on a machine the caller owns", async () => {
    vi.mocked(prisma.infraMachine.findFirst).mockResolvedValue({ id: "m1" } as never);
    const written: Buffer[] = [];
    vi.mocked(openShellChannel).mockResolvedValue({
      write: (data) => written.push(data),
      resize: () => undefined,
      close: () => undefined,
    });

    await startShell(USER, "machine:m1");
    await vi.waitFor(() => expect(openShellChannel).toHaveBeenCalled());

    expect(openShellChannel).toHaveBeenCalledWith(
      "m1",
      USER,
      expect.objectContaining({ cols: 80, rows: 24 }),
    );

    sendShellInput(USER, "machine:m1", "pwd\r");
    await vi.waitFor(() => expect(written.map(String)).toContain("pwd\r"));
  });
});
