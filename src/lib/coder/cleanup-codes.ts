/**
 * Why a coder cleanup was refused, in a form a client can act on.
 *
 * A refusal carries its reason as a code rather than by the wording of git's
 * message, so the delete dialog can offer a retry without matching English.
 */

/** A checkout with uncommitted work: `force` discards it and deletes anyway. */
export const DIRTY_WORKTREE_CODE = "dirty-worktree";

export type CoderCleanupCode = typeof DIRTY_WORKTREE_CODE;
