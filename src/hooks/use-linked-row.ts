import { useEffect, useRef } from "react";

/**
 * Open the row a page was linked to, once the list that holds it has loaded.
 *
 * A notification or a ⌘K row says which row it is about with `?id=`. The list
 * arrives a moment later, so the link waits for a matching row. Each id is used
 * once: a list that reloads (after a save, on a poll) must not reopen what the
 * user just closed.
 */
export function useLinkedRow<T>(
  rowId: string | null,
  rows: readonly T[],
  matches: (row: T, id: string) => boolean,
  open: (row: T) => void,
): void {
  const opened = useRef<string | null>(null);

  useEffect(() => {
    if (!rowId) {
      opened.current = null;
      return;
    }
    if (opened.current === rowId) return;
    const row = rows.find((candidate) => matches(candidate, rowId));
    if (!row) return;
    opened.current = rowId;
    open(row);
  }, [rowId, rows, matches, open]);
}
