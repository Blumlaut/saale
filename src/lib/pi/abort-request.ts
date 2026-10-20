/**
 * In-process record of user-requested aborts.
 *
 * Pi reports a cancelled request exactly like a failed one. `stopReason:
 * "error"` with a transport message such as `"terminated"`. so a tracker
 * reading the message cannot tell "the user pressed stop" from "the connection
 * died". Saale knows, because it performs the abort itself: the stop route
 * records the request here, and the session event tracker uses it to avoid
 * reporting its own cancellation as a provider failure.
 *
 * Scope is the process, which matches the agent pool: the request that serves
 * Stop runs in the same process as the generation and its tracker. A miss (a
 * different instance, a restart) only degrades to the previous behaviour
 * showing an error for a cancellation. never to a hidden real failure: a mark
 * is consumed by the run that follows it and cleared when any new run starts.
 */

const abortRequests = new Set<string>();

const keyFor = (userId: string, sessionId: string): string => `${userId}:${sessionId}`;

/** Record that the user is stopping this session's generation. */
export function requestSessionAbort(userId: string, sessionId: string): void {
  abortRequests.add(keyFor(userId, sessionId));
}

/**
 * Whether a stop was requested for the generation currently finishing.
 *
 * A mark only applies to a run that was already in flight: `clearSessionAbort`
 * is called when a new run starts, so a request that arrived after the previous
 * run settled cannot suppress a later, genuine failure.
 */
export function wasSessionAbortRequested(userId: string, sessionId: string): boolean {
  return abortRequests.has(keyFor(userId, sessionId));
}

/** Drop a recorded stop request (new run starting, or a finished run). */
export function clearSessionAbort(userId: string, sessionId: string): void {
  abortRequests.delete(keyFor(userId, sessionId));
}
