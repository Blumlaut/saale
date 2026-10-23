/**
 * A coder chat's terminal commands, kept alive away from the browser.
 *
 * The panel is a reader, not the owner: a dev server has to survive a closed
 * tab and a walk through the rest of the app, so the command lives here with a
 * buffer of its output and any number of SSE readers attach to it. A run ends
 * when the command exits, when the user stops it, or when the worktree goes.
 *
 * In-process, like the agent pool. The API routes that start, read, stop and
 * clear a run are all served from this process.
 */

import { exec as sandboxExec, kill as killExec } from "@/lib/sandbox/client";
import { userIdentity } from "@/lib/sandbox/identity";
import { registerTerminalExec, unregisterTerminalExec } from "@/lib/redis";

/** Output kept for a reader that comes back. A dev server prints forever. */
const MAX_RUN_OUTPUT_CHARS = 200_000;

export type TerminalStreamName = "stdout" | "stderr";

export interface TerminalRunSegment {
  stream: TerminalStreamName;
  text: string;
}

export type TerminalRunStatus = "starting" | "running" | "exited" | "failed";

/**
 * What a reader is told, in this order.
 *
 * `command` comes first so a reader that arrives mid-run knows what it is
 * watching; `started` follows when the sandbox service has named the command,
 * which is also when typing into it becomes possible.
 */
export type TerminalRunEvent =
  | { type: "command"; command: string; startedAt: number }
  | { type: "started"; execId: string }
  | { type: "data"; stream: TerminalStreamName; text: string }
  | { type: "exit"; exitCode: number; timedOut: boolean; durationMs: number }
  | { type: "error"; message: string };

/** A run's state, without its output. */
export interface TerminalRunState {
  command: string;
  startedAt: number;
  status: TerminalRunStatus;
  execId: string | null;
  exitCode: number | null;
  error: string | null;
}

/** One reader's view of a run. */
export interface TerminalAttachment {
  state: TerminalRunState;
  /** Whether the command is still running, so the stream stays open. */
  live: boolean;
  detach(): void;
}

/** Raised when a chat's terminal is already busy with a command. */
export class TerminalBusyError extends Error {
  constructor(message = "This chat's terminal is already running a command") {
    super(message);
    this.name = "TerminalBusyError";
  }
}

interface TerminalRun {
  userId: string;
  sessionId: string;
  command: string;
  startedAt: number;
  status: TerminalRunStatus;
  execId: string | null;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number | null;
  error: string | null;
  segments: TerminalRunSegment[];
  listeners: Set<(event: TerminalRunEvent) => void>;
  /** A stop that arrived before the sandbox named the command. */
  stopRequested: boolean;
}

const runs = new Map<string, TerminalRun>();

const runKey = (userId: string, sessionId: string) => `${userId}:${sessionId}`;

function isLive(run: TerminalRun): boolean {
  return run.status === "starting" || run.status === "running";
}

function toState(run: TerminalRun): TerminalRunState {
  return {
    command: run.command,
    startedAt: run.startedAt,
    status: run.status,
    execId: run.execId,
    exitCode: run.exitCode,
    error: run.error,
  };
}

function emit(run: TerminalRun, event: TerminalRunEvent): void {
  for (const listener of [...run.listeners]) {
    try {
      listener(event);
    } catch (err) {
      console.error(`Failed to tell a reader of chat ${run.sessionId}'s terminal run:`, err);
    }
  }
}

/** Append output, merging into the last segment so the buffer stays small. */
function appendOutput(run: TerminalRun, stream: TerminalStreamName, text: string): void {
  const last = run.segments[run.segments.length - 1];
  if (last && last.stream === stream) last.text += text;
  else run.segments.push({ stream, text });
  trimOutput(run);
  emit(run, { type: "data", stream, text });
}

function trimOutput(run: TerminalRun): void {
  let total = run.segments.reduce((sum, segment) => sum + segment.text.length, 0);
  while (total > MAX_RUN_OUTPUT_CHARS && run.segments.length > 0) {
    const first = run.segments[0] as TerminalRunSegment;
    const excess = total - MAX_RUN_OUTPUT_CHARS;
    if (first.text.length <= excess) {
      run.segments.shift();
      total -= first.text.length;
    } else {
      first.text = first.text.slice(excess);
      total -= excess;
    }
  }
}

/**
 * Run one command to the end, whoever is reading.
 *
 * Nothing here waits on a request: the sandbox stream is read until the command
 * exits, and readers come and go through `attachTerminalRun`.
 */
async function driveTerminalRun(run: TerminalRun, cwd: string): Promise<void> {
  // Chunk boundaries land mid-character, so text is decoded as a stream.
  const decoder = new TextDecoder();
  const identity = userIdentity(run.userId);

  try {
    for await (const event of sandboxExec({
      identity,
      command: run.command,
      cwd,
      interactive: true,
    })) {
      if (event.type === "started") {
        run.execId = event.execId;
        run.status = "running";
        await registerTerminalExec(run.userId, run.sessionId, event.execId);
        emit(run, { type: "started", execId: event.execId });
        if (run.stopRequested) await killTerminalRun(run);
      } else if (event.type === "chunk") {
        const text = decoder.decode(event.data, { stream: true });
        if (text) appendOutput(run, event.stream, text);
      } else {
        const tail = decoder.decode();
        if (tail) appendOutput(run, "stdout", tail);
        run.status = "exited";
        run.exitCode = event.exitCode;
        run.timedOut = event.timedOut;
        run.durationMs = event.durationMs;
        emit(run, {
          type: "exit",
          exitCode: event.exitCode,
          timedOut: event.timedOut,
          durationMs: event.durationMs,
        });
      }
    }

    if (isLive(run)) {
      run.status = "failed";
      run.error = "The command ended without reporting an exit code";
      emit(run, { type: "error", message: run.error });
    }
  } catch (err) {
    console.error(`Terminal command failed in chat ${run.sessionId}:`, err);
    run.status = "failed";
    run.error = err instanceof Error ? err.message : "Terminal failed";
    emit(run, { type: "error", message: run.error });
  } finally {
    if (run.execId) await unregisterTerminalExec(run.userId, run.sessionId, run.execId);
  }
}

async function killTerminalRun(run: TerminalRun): Promise<void> {
  if (!run.execId) return;
  try {
    await killExec(run.execId);
  } catch (err) {
    console.error(`Failed to stop terminal command ${run.execId} for chat ${run.sessionId}:`, err);
    throw err;
  }
}

/**
 * Start a command in the chat's worktree.
 *
 * Throws `TerminalBusyError` when the chat already has one running: the panel is
 * one shell, and a second command would have nowhere to show its output.
 */
export function beginTerminalRun(options: {
  userId: string;
  sessionId: string;
  cwd: string;
  command: string;
}): TerminalRunState {
  const { userId, sessionId, cwd, command } = options;
  const existing = runs.get(runKey(userId, sessionId));
  if (existing && isLive(existing)) throw new TerminalBusyError();

  const run: TerminalRun = {
    userId,
    sessionId,
    command,
    startedAt: Date.now(),
    status: "starting",
    execId: null,
    exitCode: null,
    timedOut: false,
    durationMs: null,
    error: null,
    segments: [],
    listeners: new Set(),
    stopRequested: false,
  };
  runs.set(runKey(userId, sessionId), run);
  void driveTerminalRun(run, cwd);

  return toState(run);
}

/**
 * Watch a chat's run, replaying what it has printed so far.
 *
 * The replay is delivered through `listener` before this returns, so no live
 * event can land ahead of it. Returns null when the chat has no run.
 */
export function attachTerminalRun(
  userId: string,
  sessionId: string,
  listener: (event: TerminalRunEvent) => void,
): TerminalAttachment | null {
  const run = runs.get(runKey(userId, sessionId));
  if (!run) return null;

  run.listeners.add(listener);
  const attachment: TerminalAttachment = {
    state: toState(run),
    live: isLive(run),
    detach: () => {
      run.listeners.delete(listener);
    },
  };

  listener({ type: "command", command: run.command, startedAt: run.startedAt });
  if (run.execId) listener({ type: "started", execId: run.execId });
  for (const segment of run.segments) {
    listener({ type: "data", stream: segment.stream, text: segment.text });
  }
  if (run.status === "exited") {
    listener({
      type: "exit",
      exitCode: run.exitCode ?? 0,
      timedOut: run.timedOut,
      durationMs: run.durationMs ?? 0,
    });
  } else if (run.status === "failed") {
    listener({ type: "error", message: run.error ?? "Terminal failed" });
  }

  return attachment;
}

/**
 * Stop the chat's running command.
 *
 * The sandbox gets a signal and the run ends through its own exit, so every
 * reader is told the same way as a command that finished on its own.
 */
export async function stopTerminalRun(userId: string, sessionId: string): Promise<boolean> {
  const run = runs.get(runKey(userId, sessionId));
  if (!run || !isLive(run)) return false;

  run.stopRequested = true;
  // The sandbox has not named it yet; the moment it does, it is killed.
  if (!run.execId) return true;

  try {
    await killTerminalRun(run);
    return true;
  } catch {
    return false;
  }
}

/**
 * Throw away what a finished run printed, or what a running one has printed so
 * far. The panel's clear button; the command itself is untouched.
 */
export function clearTerminalRun(userId: string, sessionId: string): boolean {
  const key = runKey(userId, sessionId);
  const run = runs.get(key);
  if (!run) return false;

  if (isLive(run)) {
    run.segments.length = 0;
    return true;
  }

  runs.delete(key);
  return true;
}

/** Drop a chat's run entirely: its worktree is going. Readers see it end. */
export function forgetTerminalRun(userId: string, sessionId: string): void {
  const key = runKey(userId, sessionId);
  const run = runs.get(key);
  if (!run) return;

  runs.delete(key);
  if (isLive(run)) {
    run.status = "failed";
    run.error = "The worktree was removed";
    emit(run, { type: "error", message: run.error });
  }
  run.listeners.clear();
}
