import type { AgentSession } from "@earendil-works/pi-coding-agent";

/**
 * Deferring a prompt to an in-progress compaction.
 *
 * Pi refuses to submit a prompt while a compaction holds the session
 * ("Cannot submit a prompt while compaction is in progress. Wait for
 * compaction to finish and retry."). Manual `/compact` runs in its own
 * request, so a message that arrives mid-compaction always races it. and an
 * outright rejection there is not a failure of the message: the compaction is
 * short-lived and the prompt is valid the moment it ends.
 *
 * This is the SDK's own advice, implemented: attempt the prompt, wait for the
 * session to go idle if compaction is what rejected it, and try again.
 */

/**
 * Budget for a single wait. Bounds the request in case the compaction never
 * releases the session. the message is then failed (and the failure
 * surfaced) instead of hanging forever.
 */
const DEFER_TIMEOUT_MS = 10 * 60 * 1000;

/** Retries allowed after the first attempt, before the wait's budget is spent. */
const MAX_DEFER_RETRIES = 4;

/** Pi's "compaction holds the session" rejection, identified by its message. */
function isCompactionInProgressError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("compaction is in progress");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Await `submit`, waiting out an in-progress compaction instead of failing.
 *
 * `submit` must be safe to repeat after such a rejection. it is, because Pi
 * throws before touching the transcript.
 */
export async function submitDeferringToCompaction(
  session: Pick<AgentSession, "waitForIdle">,
  submit: () => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + DEFER_TIMEOUT_MS;

  for (let attempt = 0; ; attempt++) {
    try {
      await submit();
      return;
    } catch (err) {
      if (!isCompactionInProgressError(err)) throw err;

      const remaining = deadline - Date.now();
      if (attempt >= MAX_DEFER_RETRIES || remaining <= 0) throw err;

      console.warn(
        `Prompt deferred: compaction in progress (attempt ${attempt + 1}/${MAX_DEFER_RETRIES + 1})`,
      );

      // `waitForIdle` resolves when the compaction releases the session. the
      // delay is only a bound on how long we are willing to wait for that.
      await Promise.race([session.waitForIdle(), delay(remaining)]);
    }
  }
}
