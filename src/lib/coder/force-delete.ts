/**
 * The confirmation contract for deletes that can lose uncommitted work.
 *
 * The server answers a refusal with a code, the dialog turns it into a second
 * question, and the retry sends `force`. Everything that decides is here, so a
 * new delete path only has to pass the flag along.
 */

/** The checkout was kept. a confirmed delete discards it anyway. */
export const WORKTREE_KEPT_CODE = "worktree-kept";

export type CleanupCode = typeof WORKTREE_KEPT_CODE;

/** Whether a DELETE request asked to discard what git would keep. */
export function forceRequested(url: string): boolean {
  return new URL(url).searchParams.get("force") === "1";
}

/** True when a refusal names work a second confirmation can throw away. */
export function isForcedRetry(code: string | undefined): boolean {
  return code === WORKTREE_KEPT_CODE;
}

/** True when a failed delete carries such a refusal. */
export function isForcedRetryRefusal(error: unknown): boolean {
  return isForcedRetry((error as { code?: string } | null | undefined)?.code);
}

/** An error a delete dialog will offer to retry with `force`. */
export interface ForcedRetryError extends Error {
  code: CleanupCode;
}

/** Build one for a refusal the server reported in a response body. */
export function forcedRetryError(
  message: string,
  code: CleanupCode = WORKTREE_KEPT_CODE,
): ForcedRetryError {
  return Object.assign(new Error(message), { code });
}
