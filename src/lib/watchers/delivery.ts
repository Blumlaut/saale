/**
 * Where a watcher's fire goes.
 *
 * A watcher's `sessionId` says whose context the script runs in. What happens to
 * what it reports is this: a conversation, a project (a coder chat in its own
 * worktree), or nothing at all because the script told the user itself.
 */

/** The ways a fire can be delivered. */
export const DELIVER_TARGETS = ["chat", "silent", "coder"] as const;

export type DeliverTarget = (typeof DELIVER_TARGETS)[number];

/** A per-fire worktree for every run, or one the watcher keeps. */
export const WORKTREE_MODES = ["per-fire", "sticky"] as const;

export type WorktreeMode = (typeof WORKTREE_MODES)[number];

export const DEFAULT_DELIVER: DeliverTarget = "chat";

export const DEFAULT_WORKTREE_MODE: WorktreeMode = "per-fire";

/** How long a finished bot chat is kept, in minutes: a day. */
export const DEFAULT_RETENTION_MINUTES = 24 * 60;

/** Longest retention a watcher may be given: a month. */
export const MAX_RETENTION_MINUTES = 30 * 24 * 60;

export function isDeliverTarget(value: unknown): value is DeliverTarget {
  return typeof value === "string" && (DELIVER_TARGETS as readonly string[]).includes(value);
}

/**
 * What a live watcher does with what its script returns, said in one line.
 *
 * The three targets put a fire in different places, so each gets its own
 * sentence: the model repeats this to the user as what the watcher will do.
 */
export function deliveryNote(deliver: DeliverTarget): string {
  switch (deliver) {
    case "silent":
      return "The watcher now ticks on its schedule. A fire wakes nobody: the script has to tell the user itself, for example with telegram_send.";
    case "coder":
      return "The watcher now ticks on its schedule. A fire opens a coder chat in its project, works there in its own checkout, and replies in that chat.";
    default:
      return "The watcher now ticks on its schedule. A fire is posted into its conversation and answered there.";
  }
}

export function isWorktreeMode(value: unknown): value is WorktreeMode {
  return typeof value === "string" && (WORKTREE_MODES as readonly string[]).includes(value);
}
