/**
 * The terminal panel's commands.
 *
 * A command runs in the chat's worktree through `sandbox-exec`, with stdin
 * attached, so the panel can type into whatever it started. The exec ids are
 * kept in Redis per chat: worktree removal has to stop them before it takes the
 * checkout away, and a process id nobody wrote down cannot be stopped.
 */

import { prisma } from "@/lib/db";
import { exec as sandboxExec, kill, writeInput } from "@/lib/sandbox/client";
import { userIdentity } from "@/lib/sandbox/identity";
import { getTerminalExecs, registerTerminalExec, unregisterTerminalExec } from "@/lib/redis";
import { resolveCoderPath } from "./paths";

/** Longest command the panel will run. */
export const MAX_TERMINAL_COMMAND_LENGTH = 4000;

/** What the panel needs to run a command. */
export interface TerminalTarget {
  /** Absolute path inside the container. */
  cwd: string;
  /** Workspace-relative worktree path, for the prompt. */
  worktreePath: string;
  branch: string;
}

/** A terminal command's events, as the panel shows them. */
export type TerminalEvent =
  | { type: "started"; execId: string }
  | { type: "data"; stream: "stdout" | "stderr"; text: string }
  | { type: "exit"; exitCode: number; timedOut: boolean; durationMs: number };

/** Raised when a chat has no worktree to run in yet. */
export class TerminalNotReadyError extends Error {
  constructor(message = "This chat has no worktree yet. Send a message first.") {
    super(message);
    this.name = "TerminalNotReadyError";
  }
}

/** The chat's worktree, scoped to its owner. */
export async function resolveTerminalTarget(
  userId: string,
  sessionId: string,
): Promise<TerminalTarget | null> {
  const chat = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId, projectId: { not: null } },
    select: { coderWorktree: { select: { path: true, branch: true, status: true } } },
  });
  if (!chat) return null;

  const worktree = chat.coderWorktree;
  if (!worktree || worktree.status !== "active") throw new TerminalNotReadyError();

  return {
    cwd: resolveCoderPath(userId, worktree.path),
    worktreePath: worktree.path,
    branch: worktree.branch,
  };
}

/**
 * Run one command in the chat's worktree and yield what it prints.
 *
 * Aborting kills the command rather than leaving it running: closing the panel
 * is how a person stops a dev server they no longer want.
 */
export async function* runTerminalCommand(options: {
  userId: string;
  sessionId: string;
  target: TerminalTarget;
  command: string;
  signal?: AbortSignal;
}): AsyncGenerator<TerminalEvent> {
  const { userId, sessionId, target, command, signal } = options;
  const identity = userIdentity(userId);
  // Chunk boundaries land mid-character, so text is decoded as a stream.
  const decoder = new TextDecoder();

  let execId: string | null = null;
  try {
    for await (const event of sandboxExec({
      identity,
      command,
      cwd: target.cwd,
      interactive: true,
      ...(signal ? { signal } : {}),
    })) {
      if (event.type === "started") {
        execId = event.execId;
        await registerTerminalExec(userId, sessionId, event.execId);
        yield { type: "started", execId: event.execId };
      } else if (event.type === "chunk") {
        const text = decoder.decode(event.data, { stream: true });
        if (text) yield { type: "data", stream: event.stream, text };
      } else {
        const tail = decoder.decode();
        if (tail) yield { type: "data", stream: "stdout", text: tail };
        yield {
          type: "exit",
          exitCode: event.exitCode,
          timedOut: event.timedOut,
          durationMs: event.durationMs,
        };
      }
    }
  } finally {
    if (execId) await unregisterTerminalExec(userId, sessionId, execId);
  }
}

/** Type into a command this chat started. */
export async function sendTerminalInput(options: {
  userId: string;
  sessionId: string;
  execId: string;
  data: string;
}): Promise<void> {
  const running = await getTerminalExecs(options.userId, options.sessionId);
  if (!running.has(options.execId)) throw new TerminalNotReadyError("That command is not running");

  await writeInput(options.execId, userIdentity(options.userId), options.data);
}

/**
 * Stop every command the chat's terminal started.
 *
 * The worktree cannot go while a dev server holds it open, and `pkill` cannot
 * find a command whose line never named the directory, so the panel's execs are
 * stopped by id.
 */
export async function stopTerminalExecs(userId: string, sessionId: string): Promise<number> {
  const running = await getTerminalExecs(userId, sessionId);
  let stopped = 0;

  for (const execId of running) {
    try {
      await kill(execId);
      stopped += 1;
    } catch (err) {
      console.error(`Failed to stop terminal command ${execId} for chat ${sessionId}:`, err);
    }
    await unregisterTerminalExec(userId, sessionId, execId);
  }

  return stopped;
}
