/**
 * The terminal panel's commands.
 *
 * A command runs in the chat's worktree through `sandbox-exec`, with stdin
 * attached, so the panel can type into whatever it started. The exec ids are
 * kept in Redis per chat: worktree removal has to stop them before it takes the
 * checkout away, and a process id nobody wrote down cannot be stopped.
 *
 * The run itself lives in `terminal-runs`: it outlives the request that started
 * it, so closing the panel leaves a dev server running.
 */

import { prisma } from "@/lib/db";
import { kill, writeInput } from "@/lib/sandbox/client";
import { userIdentity } from "@/lib/sandbox/identity";
import { getTerminalExecs, unregisterTerminalExec } from "@/lib/redis";
import { checkoutOf } from "./checkout";
import { resolveCoderPath } from "./paths";

/** Longest command the panel will run. */
export const MAX_TERMINAL_COMMAND_LENGTH = 4000;

/** What the panel needs to run a command. */
export interface TerminalTarget {
  /** Absolute path inside the container. */
  cwd: string;
  /** Workspace-relative checkout path, for the prompt. */
  worktreePath: string;
  branch: string;
}

/** Raised when a chat has no checkout to run in yet. */
export class TerminalNotReadyError extends Error {
  constructor(message = "This chat has no worktree yet. Send a message first.") {
    super(message);
    this.name = "TerminalNotReadyError";
  }
}

/** The chat's checkout, scoped to its owner. */
export async function resolveTerminalTarget(
  userId: string,
  sessionId: string,
): Promise<TerminalTarget | null> {
  const chat = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId, projectId: { not: null } },
    select: {
      project: { select: { repoPath: true, chatMode: true } },
      coderWorktree: { select: { path: true, branch: true, baseSha: true, status: true } },
    },
  });
  if (!chat) return null;

  const checkout = checkoutOf(chat);
  if (!checkout) throw new TerminalNotReadyError();

  return {
    cwd: resolveCoderPath(userId, checkout.path),
    worktreePath: checkout.path,
    branch: checkout.branch,
  };
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
