/**
 * Streaming a growing text field.
 *
 * Pi hands over the whole field with every delta (the text so far, not what it
 * gained), so passing that on verbatim spends the field's own length again on
 * every token: a long reasoning block costs its own size per token, and the
 * client falls further behind the longer the block runs.
 *
 * These helpers are the shape both ends agree on. The sender publishes the
 * appended chunk (`nextTextStep`) and hauls the whole field out on a slow
 * cadence, which is what lands a client that joined mid-run or missed a chunk.
 * The receiver appends a chunk only where it belongs (`appendTextChunk`).
 */

/**
 * The part of `next` that `previous` does not have yet, or null when `next`
 * does not extend it (a retried turn, a rewritten block).
 */
export function appendedText(previous: string, next: string): string | null {
  if (next.length <= previous.length || !next.startsWith(previous)) return null;
  return next.slice(previous.length);
}

/** How a growing field should go out, or null when it has nothing new. */
export type TextStep =
  { kind: "snapshot"; text: string } | { kind: "delta"; delta: string; offset: number } | null;

/**
 * Decide whether a growing field goes out as the whole thing or as the chunk it
 * gained.
 *
 * `offset` is the field's length before the chunk, which is what a client
 * checks itself against before appending: a gap (a trimmed replay buffer, a
 * dropped event) is left for the next snapshot to repair rather than spliced in
 * at the wrong place.
 */
export function nextTextStep(params: {
  previous: string;
  next: string;
  /** When this field last went out whole, or null when it never did. */
  lastSnapshotAt: number | null;
  now: number;
  snapshotIntervalMs: number;
}): TextStep {
  const { previous, next, lastSnapshotAt, now, snapshotIntervalMs } = params;
  if (!next || next === previous) return null;

  const delta = appendedText(previous, next);
  if (delta === null || lastSnapshotAt === null || now - lastSnapshotAt >= snapshotIntervalMs) {
    return { kind: "snapshot", text: next };
  }
  return { kind: "delta", delta, offset: previous.length };
}

/**
 * The field with `delta` appended, or null when the client is not where the
 * chunk starts (it missed one; the next snapshot lands the field).
 */
export function appendTextChunk(current: string, delta: string, offset: number): string | null {
  if (current.length !== offset) return null;
  return current + delta;
}
