import type { AgentSession } from "@earendil-works/pi-coding-agent";

/**
 * Idle timeout for a running Pi agent session.
 *
 * Unlike a wall-clock timeout, this only fires when the session has
 * produced NO events at all for `timeoutMs` (hung model, stuck tool, dead
 * connection). Any agent activity — streamed tokens, thinking, tool
 * execution, turns, compaction — resets the window, so an actively working
 * agent can run for far longer than `timeoutMs` in total.
 *
 * Approval waits cannot outlive the window either: the approval gate
 * auto-denies after its own deadline (5 min) and the resulting tool result
 * produces events that reset the timer.
 */
export interface AgentIdleTimeout {
  /**
   * Reset the idle window. Called automatically for every session event;
   * call manually for activity that does not surface as a session event.
   */
  noteActivity(): void;
  /**
   * Stop the timer and detach from the session. Idempotent — safe to call
   * from both success and error paths. Events arriving after `clear()` do
   * not re-arm the timer.
   */
  clear(): void;
}

export interface CreateAgentIdleTimeoutOptions {
  /** The session to watch; every event it emits resets the window. */
  session: Pick<AgentSession, "subscribe">;
  /** How long the session may stay silent before it is considered stalled. */
  timeoutMs: number;
  /** Label used in log output, e.g. `telegram:${runId}`. */
  label: string;
  /**
   * Called exactly once when the session has produced no events for
   * `timeoutMs`. The helper has already detached its own listener; the
   * caller performs its own cleanup (unsubscribe, abort, reject).
   */
  onTimeout: () => void;
}

export function createAgentIdleTimeout({
  session,
  timeoutMs,
  label,
  onTimeout,
}: CreateAgentIdleTimeoutOptions): AgentIdleTimeout {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let resetUnsub: (() => void) | undefined;

  const arm = () => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      stopped = true;
      resetUnsub?.();
      resetUnsub = undefined;
      console.error(
        `${label}: no session events for ${Math.round(timeoutMs / 1000)}s — treating run as stalled`,
      );
      onTimeout();
    }, timeoutMs);
  };

  const clear = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    resetUnsub?.();
    resetUnsub = undefined;
  };

  // Every session event counts as activity and resets the window.
  resetUnsub = session.subscribe(() => {
    arm();
  });

  arm();

  return { noteActivity: arm, clear };
}
