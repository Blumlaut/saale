/**
 * Stopping what a chat has running.
 *
 * A dev server usually does not have its directory in its command line
 * (`python3 -m http.server 8080` says nothing about where it runs), so matching
 * the command line is not enough. Two things find the rest: the chat id every
 * command of a chat carries in its environment, and, for a checkout the chat
 * has to itself, the kernel's record of a process's working directory, which
 * catches one started by a shell the chat has since forgotten.
 *
 * The chat id is what makes this safe in a project that runs every one of its
 * chats in the same checkout: a sibling chat's dev server carries its own id
 * and is left alone.
 *
 * `procRoot` is a parameter so the script can be run against a directory of
 * symlinks in a test.
 */

import { runInWorkspace, shellQuote } from "./git";
import { stopTerminalExecs } from "./terminal";
import { forgetTerminalRun } from "./terminal-runs";

/** Longer than a teardown should take; the sweep is a loop over processes. */
export const SWEEP_TIMEOUT_SECONDS = 30;

/** What one sweep looks for. */
export interface ProcessTargets {
  /** The chat whose commands carry its id in their environment. */
  chatId: string;
  /** A directory only this chat works in, matched by path as well. */
  ownCheckout?: string | null;
}

/**
 * The shell that stops everything `targets` names.
 *
 * Every pass ignores its own failures: nothing matching is the ordinary case,
 * and the exit status of the whole script is its own.
 */
export function stopProcessesCommand(targets: ProcessTargets, procRoot = "/proc"): string {
  const checkout = targets.ownCheckout ? shellQuote(targets.ownCheckout) : null;
  const lines: string[] = [];
  if (checkout) lines.push(`pkill -f ${checkout} >/dev/null 2>&1`, `root=${checkout}`);
  lines.push(
    `chat=${shellQuote(targets.chatId)}`,
    `for p in ${procRoot}/[0-9]*; do`,
    `  pid="\${p##*/}"`,
    // Skip the shell running this loop.
    `  [ "$pid" = "$$" ] && continue`,
    // Whatever a command of this chat started carries its id in its environment.
    `  if tr '\\0' '\\n' < "$p/environ" 2>/dev/null | grep -qxF "SAALE_CHAT_ID=$chat"; then`,
    `    kill -KILL "$pid" 2>/dev/null`,
    `    continue`,
    `  fi`,
  );
  if (checkout) {
    lines.push(
      `  cwd=$(readlink "$p/cwd" 2>/dev/null) || continue`,
      `  case "$cwd" in`,
      `    "$root"|"$root"/*) kill -KILL "$pid" 2>/dev/null ;;`,
      `  esac`,
    );
  }
  lines.push(`done`, `true`);
  return lines.join("\n");
}

/**
 * Stop everything one chat left running.
 *
 * A dev server or a watcher the agent left behind keeps working after the chat
 * is gone: it holds its files open and it holds the port. The panel's commands
 * go first, by id, since neither their command line nor their environment names
 * the chat; the sweep catches the rest.
 */
export async function stopChatProcesses(
  userId: string,
  sessionId: string,
  options: { ownCheckout?: string | null } = {},
): Promise<void> {
  const stopped = await stopTerminalExecs(userId, sessionId);
  if (stopped > 0) console.warn(`[coder] stopped ${stopped} terminal command(s) of ${sessionId}`);
  // The run belonged to the chat, so the panel's record of it goes with it.
  forgetTerminalRun(userId, sessionId);

  const result = await runInWorkspace(userId, {
    cwd: ".",
    command: stopProcessesCommand({
      chatId: sessionId,
      ownCheckout: options.ownCheckout ?? null,
    }),
    timeoutSeconds: SWEEP_TIMEOUT_SECONDS,
  });
  if (result.exitCode !== 0) {
    console.warn(`[coder] stopping the processes of ${sessionId} exited ${result.exitCode}`);
  }
}
