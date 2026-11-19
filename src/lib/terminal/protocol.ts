/**
 * What the console and the shell API say to each other.
 *
 * Pure types: a client component reads them without dragging Prisma or SSH
 * into its bundle.
 */

export type ShellStatus = "starting" | "open" | "closed";

/** A shell as the API describes it. */
export interface ShellState {
  target: string;
  status: ShellStatus;
  /** Why the shell ended, when it did not end on its own. */
  error: string | null;
  cols: number;
  rows: number;
}
