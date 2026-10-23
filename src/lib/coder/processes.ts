/**
 * Stopping what a worktree has running.
 *
 * A dev server usually does not have its directory in its command line
 * (`python3 -m http.server 8080` says nothing about where it runs), so matching
 * the command line is not enough. The second pass asks the kernel which process
 * has a working directory inside the worktree, which is what catches one that
 * was started by a shell the chat has since forgotten.
 *
 * `procRoot` is a parameter so the script can be run against a directory of
 * symlinks in a test.
 */

import { shellQuote } from "./git";

/** Longer than a teardown should take; the sweep is a loop over processes. */
export const SWEEP_TIMEOUT_SECONDS = 30;

/**
 * The shell that stops everything running in `root`.
 *
 * Both passes ignore their own failures: nothing matching is the ordinary case,
 * and the exit status of the whole script is its own.
 */
export function stopProcessesCommand(root: string, procRoot = "/proc"): string {
  const quoted = shellQuote(root);
  return [
    `pkill -f ${quoted} >/dev/null 2>&1`,
    `root=${quoted}`,
    `for p in ${procRoot}/[0-9]*; do`,
    `  pid="\${p##*/}"`,
    // The shell reading this tree has a cwd of its own, and it is not for killing.
    `  [ "$pid" = "$$" ] && continue`,
    `  cwd=$(readlink "$p/cwd" 2>/dev/null) || continue`,
    `  case "$cwd" in`,
    `    "$root"|"$root"/*) kill -KILL "$pid" 2>/dev/null ;;`,
    `  esac`,
    `done`,
    `true`,
  ].join("\n");
}
