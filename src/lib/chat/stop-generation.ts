import { holdSendQueue, isSessionActive, unregisterActiveSession } from "@/lib/redis";
import { get, getPoolKey } from "@/lib/pi/agent-pool";
import { requestSessionAbort } from "@/lib/pi/abort-request";

/**
 * Explicitly cancel an in-progress generation.
 *
 * Different from client disconnect (navigation/refresh) — this is a
 * user-initiated "stop" that aborts the LLM, clears the active session flag
 * immediately, and pauses the send queue until the user sends or pushes
 * something.
 *
 * Shared by `POST /stop` and the `/stop` command.
 *
 * @returns true when a run was actually cancelled (false when nothing was).
 */
export async function stopChatGeneration(userId: string, sessionId: string): Promise<boolean> {
  // Idempotent: nothing to cancel if the session is neither flagged active in
  // Redis nor streaming in this process. The flag is cross-process bookkeeping
  // and can be missing (an expired key, a Redis restart, a generation started
  // before the flag was written) — the pooled session is the local truth, so a
  // stale flag must not make Stop a silent no-op.
  const isActive = await isSessionActive(userId, sessionId);
  const poolKey = getPoolKey(userId, sessionId);
  const pooled = get(poolKey);
  const isStreamingHere = pooled?.session.isStreaming ?? false;

  if (!isActive && !isStreamingHere) return false;

  // A stop pauses the send queue as well: whatever was queued during this run
  // must not start sending the moment the abort lands (see redis.ts).
  await holdSendQueue(sessionId);

  if (pooled && isStreamingHere) {
    // Record the stop before aborting: the tracker cannot tell a cancelled
    // request from a failed one, and must not report the user's own action as
    // a provider error.
    requestSessionAbort(userId, sessionId);
    pooled.session.abort();
    // Don't remove from pool — let it be reused for the next message
    // (eviction handles cleanup)
  }

  // Clear Redis tracking (works across instances)
  await unregisterActiveSession(userId, sessionId);
  return true;
}
