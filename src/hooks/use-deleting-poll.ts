import { useEffect } from "react";

/** How often a list asks again while a row is on its way out. */
export const DELETING_POLL_MS = 2_000;

/**
 * Ask the server again while it is still removing a row.
 *
 * A delete answers before the work is done, so the row stays in the list until
 * the removal finishes and there is no event to wait for. `deleting` is the
 * list's own answer to "is anything still going", which stops the polling as
 * soon as the last row is gone.
 */
export function useDeletingPoll(deleting: boolean, refresh: () => void): void {
  useEffect(() => {
    if (!deleting) return;
    const timer = setInterval(refresh, DELETING_POLL_MS);
    return () => clearInterval(timer);
  }, [deleting, refresh]);
}
