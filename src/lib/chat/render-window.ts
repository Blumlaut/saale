/**
 * The transcript's render window.
 *
 * A long transcript is thousands of DOM nodes (markdown, highlighting, tool
 * cards), and every layout pass pays for all of them, including the composer's
 * per-keystroke autosize reflow. Only the tail is mounted; earlier turns are
 * revealed on demand.
 *
 * Counted in rows as well as turns: a coder turn runs hundreds of steps, each
 * its own message with its own card, so twenty turns of a busy chat would be a
 * window of thousands of mounted components.
 */

/** Turns a transcript mounts before it paginates. */
export const INITIAL_WINDOW_GROUPS = 20;
/** Turns one click of the reveal control adds. */
export const WINDOW_GROWTH_GROUPS = 30;
/** Rows a paginated window mounts. */
export const WINDOW_ROW_BUDGET = 150;
/**
 * Rows a live window may reach before it paginates again.
 *
 * A window that grows holds its start (see `tailWindowStart`), so a run that
 * keeps working never hides the turns above it. The cap is what stops a
 * session left open all day from mounting every turn it ever showed.
 */
export const WINDOW_ROW_CAP = WINDOW_ROW_BUDGET * 3;
/** Steps one click of a turn's earlier-steps control adds. */
export const STEP_REVEAL_ROWS = 60;

/**
 * The turns a window can start at.
 *
 * A transcript is rebuilt on every token and a turn's cost is worked out from
 * its messages, so a walk reads the turns it crosses and nothing else.
 */
export interface WindowTurns {
  readonly length: number;
  /** The turn's render key. a rebuilt list keeps it. */
  anchor(index: number): string;
  /** Rows the turn mounts, never more than one window's worth. */
  rows(index: number): number;
  /** The turn opens a run: a prompt, or the notice that compacted one. */
  prompt(index: number): boolean;
}

/** Rows a window starting at `from` mounts. */
export function windowRows(turns: WindowTurns, from: number): number {
  let total = 0;
  for (let index = from; index < turns.length; index++) total += turns.rows(index);
  return total;
}

/**
 * First turn of a window paginated to the tail: the newest turns that reach the
 * row budget.
 *
 * The turn that crosses the budget is included. It folds its own steps, so it
 * mounts as much of the budget as it fills, and a long turn stays in the window
 * whole.
 */
export function windowStartFor(turns: WindowTurns): number {
  let total = 0;
  let start = turns.length;
  while (start > 0 && turns.length - start < INITIAL_WINDOW_GROUPS && total < WINDOW_ROW_BUDGET) {
    start -= 1;
    total += turns.rows(start);
  }
  return toPrompt(turns, start);
}

/**
 * Take the prompt the window's first turn answers.
 *
 * A window that opens between a prompt and its answer shows the answer to a
 * question the reader cannot see, which reads as a transcript that lost a turn.
 */
function toPrompt(turns: WindowTurns, start: number): number {
  return start > 0 && !turns.prompt(start) && turns.prompt(start - 1) ? start - 1 : start;
}

/**
 * First turn after revealing earlier ones: `WINDOW_GROWTH_GROUPS` more turns,
 * and no more than one row budget's worth.
 */
export function revealStartFor(turns: WindowTurns, from: number): number {
  let total = 0;
  let start = from;
  while (start > 0 && from - start < WINDOW_GROWTH_GROUPS && total < WINDOW_ROW_BUDGET) {
    start -= 1;
    total += turns.rows(start);
  }
  return toPrompt(turns, start);
}

/**
 * First turn of a live window: where the reader's view starts, given the turn
 * the window started at last time.
 *
 * `held` keeps a working run from sliding the window along under the reader:
 * arriving messages append below the held turn and the hidden count stays put.
 *
 * The hold lets go when the anchored turn is gone (a reload, a compaction,
 * another conversation), when the window outgrew `WINDOW_ROW_CAP`, and when
 * there is no anchor yet.
 */
export function tailWindowStart(turns: WindowTurns, held: string | null): number {
  if (held !== null) {
    for (let index = 0; index < turns.length; index++) {
      if (turns.anchor(index) !== held) continue;
      return windowRows(turns, index) <= WINDOW_ROW_CAP ? index : windowStartFor(turns);
    }
  }
  return windowStartFor(turns);
}

/** Anchor of the turn a window starts at, for the next growth to hold. */
export function windowAnchor(turns: WindowTurns, start: number): string | null {
  return start >= 0 && start < turns.length ? turns.anchor(start) : null;
}

/**
 * First step of one turn's transcript: the newest window's worth, or everything
 * from where the reader unfolded it.
 *
 * Held like the message window, so a step a reader opened stays on screen while
 * the run adds more. It lets go past `WINDOW_ROW_CAP`, on the same terms.
 */
export function stepWindowStart(count: number, unfoldedAt: number | null): number {
  if (unfoldedAt !== null && unfoldedAt < count && count - unfoldedAt <= WINDOW_ROW_CAP) {
    return unfoldedAt;
  }
  return Math.max(0, count - WINDOW_ROW_BUDGET);
}
