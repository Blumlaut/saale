/**
 * Where an automation's fire goes.
 *
 * A `chat` fire is the only one with a conversation to report into, so it is the
 * only delivery that carries a `sessionId`. A `coder` fire opens a chat in its
 * project, `none` runs the agent on its own and leaves delivery to its tools,
 * and a `silent` one is delivered by the script itself, so all three run
 * without a chat and survive one being deleted.
 */

/** The ways a fire can be delivered. */
export const DELIVER_TARGETS = ["chat", "none", "silent", "coder"] as const;

export type DeliverTarget = (typeof DELIVER_TARGETS)[number];

/** A per-fire worktree for every run, or one the automation keeps. */
export const WORKTREE_MODES = ["per-fire", "sticky"] as const;

export type WorktreeMode = (typeof WORKTREE_MODES)[number];

export const DEFAULT_DELIVER: DeliverTarget = "chat";

export const DEFAULT_WORKTREE_MODE: WorktreeMode = "per-fire";

/** How long a finished coder chat is kept, in minutes: a day. */
export const DEFAULT_RETENTION_MINUTES = 24 * 60;

/** Longest retention an automation may be given: a month. */
export const MAX_RETENTION_MINUTES = 30 * 24 * 60;

export function isDeliverTarget(value: unknown): value is DeliverTarget {
  return typeof value === "string" && (DELIVER_TARGETS as readonly string[]).includes(value);
}

/**
 * What a live automation does with what its script returns, said in one line.
 *
 * The targets put a fire in different places, so each gets its own sentence: the
 * model repeats this to the user as what the automation will do.
 */
export function deliveryNote(deliver: DeliverTarget): string {
  switch (deliver) {
    case "silent":
      return "The automation now ticks on its schedule. A fire wakes nobody: the script has to tell the user itself, for example with telegram_send.";
    case "none":
      return "The automation now ticks on its schedule. A fire runs you on your own, with no chat to answer in: anything the user hears about has to come from your tools.";
    case "coder":
      return "The automation now ticks on its schedule. A fire opens a coder chat in its project, works there in its own checkout, and replies in that chat.";
    default:
      return "The automation now ticks on its schedule. A fire is posted into its conversation and answered there.";
  }
}

export function isWorktreeMode(value: unknown): value is WorktreeMode {
  return typeof value === "string" && (WORKTREE_MODES as readonly string[]).includes(value);
}
