/**
 * A terminal on one of a user's workspaces, kept open away from the browser.
 *
 * The files page's console holds a shell: the directory it was opened in, the
 * jobs it started and the prompt they come back to are the point. So the session lives here, its output is buffered, and any number of
 * SSE readers attach to it. It ends when the user closes it, when the shell
 * exits, or when this process restarts.
 *
 * Two backends answer the same four questions, write, resize, read and close:
 * a sandbox container for the user's own workspace, and an SSH channel for a
 * machine. Nothing above this module knows which one it is talking to.
 *
 * In-process, like the coder terminal runs. The API routes that start, read and
 * close a shell are all served from this process.
 */

import { prisma } from "@/lib/db";
import { openShellChannel, type RemoteShell } from "@/lib/infra/client";
import { parseFileTargetToken } from "@/lib/files/target-tokens";
import {
  canExec,
  exec as sandboxExec,
  kill as killExec,
  resize as resizeExec,
  writeInput,
} from "@/lib/sandbox/client";
import { userIdentity } from "@/lib/sandbox/identity";
import { ensureWorkspace } from "@/lib/sandbox/workspace";
import type { ShellState, ShellStatus } from "./protocol";

export type { ShellState, ShellStatus } from "./protocol";

/** Output kept for a reader that comes back. A shell prints without end. */
const MAX_OUTPUT_CHARS = 200_000;

/** What the terminal calls itself. Programs that draw a screen ask for it. */
const TERM = "xterm-256color";

/**
 * How long a shell with no reader is kept.
 *
 * A shell is left open on purpose, so a dev server started in it keeps running
 * while the user reads something else. Nobody coming back for half an hour
 * means nobody is coming back, and the container the shell holds is not left
 * waiting for one.
 */
const SHELL_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export const DEFAULT_SHELL_COLS = 80;
export const DEFAULT_SHELL_ROWS = 24;
/** Widest and tallest a browser may claim its terminal is. */
export const MAX_SHELL_DIMENSION = 1000;

export type ShellEvent =
  { type: "output"; text: string } | { type: "closed"; error: string | null };

/** One reader's view of a shell. */
export interface ShellAttachment {
  state: ShellState;
  live: boolean;
  detach(): void;
}

/** A target that cannot have a shell: unknown, not the caller's, or unavailable. */
export class ShellUnavailableError extends Error {
  readonly status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.name = "ShellUnavailableError";
    this.status = status;
  }
}

interface Backend {
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

interface Shell {
  userId: string;
  target: string;
  status: ShellStatus;
  error: string | null;
  cols: number;
  rows: number;
  /** Everything printed so far, oldest trimmed. */
  output: string;
  listeners: Set<(event: ShellEvent) => void>;
  backend: Backend | null;
  /** A close that arrived before the backend could be named. */
  closeRequested: boolean;
  /** Keystrokes typed before the shell was ready to read them. */
  pending: Buffer[];
  /** Closes a shell no reader has come back to. */
  idleTimer: NodeJS.Timeout | null;
}

/**
 * The shells this process holds.
 *
 * Anchored on `globalThis` because Next builds a server module into a bundle
 * per route: a map that lives in one copy is invisible to the route that types
 * into the shell, or the one that reads it.
 */
const registry = globalThis as unknown as { saaleShells?: Map<string, Shell> };
const shells = (registry.saaleShells ??= new Map<string, Shell>());

const shellKey = (userId: string, target: string) => `${userId}:${target}`;

function isLive(shell: Shell): boolean {
  return shell.status === "starting" || shell.status === "open";
}

function toState(shell: Shell, target: string): ShellState {
  return { target, status: shell.status, error: shell.error, cols: shell.cols, rows: shell.rows };
}

function emit(shell: Shell, event: ShellEvent): void {
  for (const listener of [...shell.listeners]) {
    try {
      listener(event);
    } catch (err) {
      console.error("Failed to tell a reader of a shell:", err);
    }
  }
}

function appendOutput(shell: Shell, text: string): void {
  shell.output += text;
  if (shell.output.length > MAX_OUTPUT_CHARS) {
    shell.output = shell.output.slice(shell.output.length - MAX_OUTPUT_CHARS);
  }
  emit(shell, { type: "output", text });
}

/** End a shell once, telling every reader the same thing. */
function finish(shell: Shell, error: string | null): void {
  if (shell.status === "closed") return;
  shell.status = "closed";
  shell.error = error;
  shell.backend = null;
  emit(shell, { type: "closed", error });
}

/** Drop a shell's timer, because another shell may own the key by now. */
function stopIdleTimer(shell: Shell): void {
  if (!shell.idleTimer) return;
  clearTimeout(shell.idleTimer);
  shell.idleTimer = null;
}

/** Close a shell once nobody has read it for the idle timeout. */
function scheduleIdleClose(shell: Shell): void {
  if (shell.idleTimer) {
    clearTimeout(shell.idleTimer);
    shell.idleTimer = null;
  }
  shell.idleTimer = setTimeout(() => {
    shell.idleTimer = null;
    // A restart puts a new shell under the same key, so this timer would close
    // the wrong one.
    if (shells.get(shellKey(shell.userId, shell.target)) !== shell) return;
    if (shell.listeners.size > 0) return;
    closeShell(shell.userId, shell.target);
  }, SHELL_IDLE_TIMEOUT_MS);
  // A shell waiting for a reader must not keep the process up.
  shell.idleTimer.unref?.();
}

/** A shell in the user's own workspace, run in its sandbox container. */
async function driveWorkspace(shell: Shell, userId: string): Promise<void> {
  const identity = userIdentity(userId);
  const decoder = new TextDecoder();

  try {
    const cwd = await ensureWorkspace(identity);

    // A terminal program needs a terminal: `bash` is interactive here because
    // its stdin is the pty the sandbox service gives it.
    for await (const event of sandboxExec({
      identity,
      command: "bash",
      cwd,
      interactive: true,
      tty: true,
      cols: shell.cols,
      rows: shell.rows,
      env: { TERM },
    })) {
      if (event.type === "started") {
        // Closed while the container was starting: the command is its to kill.
        if (shell.closeRequested) {
          void killExec(event.execId);
          return;
        }
        shell.status = "open";
        const backend: Backend = {
          write: (data) => void writeInput(event.execId, identity, data),
          resize: (cols, rows) => void resizeExec(event.execId, cols, rows, identity),
          close: () => void killExec(event.execId),
        };
        shell.backend = backend;
        for (const pending of shell.pending.splice(0)) backend.write(pending);
        // The browser may have said how big it is before the pty existed.
        backend.resize(shell.cols, shell.rows);
      } else if (event.type === "chunk") {
        const text = decoder.decode(event.data, { stream: true });
        if (text) appendOutput(shell, text);
      } else {
        const tail = decoder.decode();
        if (tail) appendOutput(shell, tail);
        finish(shell, event.exitCode === 0 ? null : `The shell exited with code ${event.exitCode}`);
      }
    }
    // A stream that ends without an exit event still ends the shell.
    if (isLive(shell)) finish(shell, "The shell stopped");
  } catch (err) {
    console.error(`The workspace shell for ${userId} failed:`, err);
    finish(shell, err instanceof Error ? err.message : "The shell could not start");
  }
}

/** A shell on a machine, over one SSH channel held open for it. */
async function driveMachine(shell: Shell, userId: string, machineId: string): Promise<void> {
  try {
    const remote: RemoteShell = await openShellChannel(machineId, userId, {
      cols: shell.cols,
      rows: shell.rows,
      onData: (text) => appendOutput(shell, text),
      onClose: () => finish(shell, shell.closeRequested ? null : "The machine closed the shell"),
    });

    // Closed while the machine was answering: no reader wants this channel.
    if (shell.closeRequested) {
      remote.close();
      return;
    }

    shell.status = "open";
    shell.backend = remote;
    for (const pending of shell.pending.splice(0)) remote.write(pending);
    // The browser may have said how big it is before the channel existed.
    remote.resize(shell.cols, shell.rows);
  } catch (err) {
    console.error(`The shell on machine ${machineId} failed:`, err);
    finish(shell, err instanceof Error ? err.message : "The machine did not answer");
  }
}

/**
 * Whether a shell can be opened for a target at all.
 *
 * Asked before the console is offered, so a deployment without the sandbox
 * service has no console to open.
 */
export async function shellAvailability(
  userId: string,
  target: string,
): Promise<{ available: boolean; reason: string | null }> {
  const parsed = parseFileTargetToken(target);
  if (!parsed) return { available: false, reason: "Unknown terminal target" };

  if (parsed.kind === "workspace") {
    return canExec()
      ? { available: true, reason: null }
      : { available: false, reason: "This deployment cannot run commands" };
  }

  const machine = await prisma.infraMachine.findFirst({
    where: { id: parsed.machineId, userId },
    select: { id: true },
  });
  return machine
    ? { available: true, reason: null }
    : { available: false, reason: "That machine is not one of yours" };
}

/**
 * Open a shell for a target, or hand back the one already running.
 *
 * The target is the same token the file browser sends: `user` or
 * `machine:<id>`. Ownership of the machine is checked before a connection is
 * made, because a machine id is guessable and its credentials are not.
 */
export async function startShell(userId: string, target: string): Promise<ShellState> {
  const parsed = parseFileTargetToken(target);
  if (!parsed) throw new ShellUnavailableError("Unknown terminal target", 400);

  const key = shellKey(userId, target);
  const existing = shells.get(key);
  if (existing && isLive(existing)) return toState(existing, target);
  // The shell this one replaces is over; its timer must not outlive the key.
  if (existing) stopIdleTimer(existing);

  if (parsed.kind === "machine") {
    const machine = await prisma.infraMachine.findFirst({
      where: { id: parsed.machineId, userId },
      select: { id: true },
    });
    if (!machine) throw new ShellUnavailableError("That machine is not one of yours", 404);
  } else if (!canExec()) {
    throw new ShellUnavailableError("This deployment cannot run commands");
  }

  const shell: Shell = {
    userId,
    target,
    status: "starting",
    error: null,
    cols: DEFAULT_SHELL_COLS,
    rows: DEFAULT_SHELL_ROWS,
    output: "",
    listeners: new Set(),
    backend: null,
    closeRequested: false,
    pending: [],
    idleTimer: null,
  };
  shells.set(key, shell);

  if (parsed.kind === "machine") void driveMachine(shell, userId, parsed.machineId);
  else void driveWorkspace(shell, userId);

  // A shell nobody ever reads is still a container being held open.
  scheduleIdleClose(shell);

  return toState(shell, target);
}

/**
 * Watch a shell, replaying what it has printed so far.
 *
 * The replay is delivered before this returns, so no live output can land
 * ahead of it.
 */
export function attachShell(
  userId: string,
  target: string,
  listener: (event: ShellEvent) => void,
): ShellAttachment | null {
  const shell = shells.get(shellKey(userId, target));
  if (!shell) return null;

  stopIdleTimer(shell);
  shell.listeners.add(listener);
  if (shell.output) listener({ type: "output", text: shell.output });

  const live = isLive(shell);
  if (!live) listener({ type: "closed", error: shell.error });

  return {
    state: toState(shell, target),
    live,
    detach: () => {
      shell.listeners.delete(listener);
      if (shell.listeners.size > 0) return;

      scheduleIdleClose(shell);
    },
  };
}

/** Type into a shell, waiting in a queue until it is ready when it is not. */
export function sendShellInput(userId: string, target: string, data: string): boolean {
  const shell = shells.get(shellKey(userId, target));
  if (!shell || !isLive(shell) || data.length === 0) return false;

  const bytes = Buffer.from(data, "utf8");
  if (!shell.backend) {
    shell.pending.push(bytes);
    return true;
  }
  shell.backend.write(bytes);
  return true;
}

/** Tell a shell how big its terminal became. */
export function resizeShell(userId: string, target: string, cols: number, rows: number): boolean {
  const shell = shells.get(shellKey(userId, target));
  if (!shell || !isLive(shell)) return false;

  shell.cols = cols;
  shell.rows = rows;
  shell.backend?.resize(cols, rows);
  return true;
}

/**
 * Close a shell and forget it.
 *
 * The output goes with it: a new shell starts a new buffer, and replaying the
 * old one into it would read as the same session continuing.
 */
export function closeShell(userId: string, target: string): boolean {
  const key = shellKey(userId, target);
  const shell = shells.get(key);
  if (!shell) return false;

  stopIdleTimer(shell);
  // Held before the session ends: finishing it drops the backend.
  const backend = shell.backend;
  shell.closeRequested = true;
  // Every reader is told before the listeners go, so no stream waits on a shell
  // that will never print again.
  finish(shell, null);
  shell.listeners.clear();
  shells.delete(key);
  backend?.close();
  return true;
}
