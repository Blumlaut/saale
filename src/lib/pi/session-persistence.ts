/**
 * Session-scoped DB persistence for chat agent events.
 *
 * Thin wrapper around SessionEventTracker: wires a tracker to a pooled agent
 * session for ONE run, and tracks the wiring so pool eviction can tear it down.
 *
 * The SSE stream route is purely an observer. all persistence and stream
 * event publishing happens inside the tracker.
 *
 * A run ends in two steps: the tracker publishes `done` (after its pending DB
 * writes settle) and then unsubscribes. The next run must not start in that
 * window. a tracker wired mid-teardown would be replaced by the old entry's
 * guard and the new run would go completely unpersisted, and two live trackers
 * would double-publish every stream event. `wireSessionPersistence` replaces a
 * stale tracker, and `waitForPersistenceTeardown` lets a caller (the send
 * queue drain) wait for the previous run to be fully torn down first.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createSessionEventTracker, type SessionEventTracker } from "./session-event-tracker";

/** Per-session persistence state (one entry per pooled session). */
interface PersistenceState {
  dispose: () => void;
  /** Resolves once the run settled, `done` was published, and the tracker unsubscribed. */
  teardown: Promise<void>;
  /** Settles the teardown promise exactly once. */
  finish: () => void;
}

/** In-memory store: sessionId → persistence state. */
const persistenceMap = new Map<string, PersistenceState>();

/**
 * Wire DB persistence + stream event publishing for a pooled session.
 *
 * Called once per run, when the session enters the pool or when a new run
 * starts. A tracker from the previous run that is still tearing down is
 * disposed first, so it can never observe (and double-publish) the new run.
 *
 * @param sessionId - ChatSession.id from DB
 * @param userId - Authenticated user ID
 * @param session - The AgentSession to subscribe to
 */
export function wireSessionPersistence(
  sessionId: string,
  userId: string,
  session: AgentSession,
): void {
  const existing = persistenceMap.get(sessionId);
  if (existing) {
    existing.dispose();
  }

  let finish = () => {};
  const teardown = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const state: PersistenceState = {
    dispose: () => {},
    teardown,
    finish,
  };

  const tracker: SessionEventTracker = createSessionEventTracker({
    sessionId,
    userId,
    session,
    onDone: () => {
      // A later run may already have wired its own tracker. only clear ours.
      if (persistenceMap.get(sessionId) !== state) return;
      persistenceMap.delete(sessionId);
      finish();
    },
  });

  state.dispose = () => {
    tracker.dispose();
    // A disposed tracker never reaches `done`; waiting callers must not hang.
    finish();
  };

  persistenceMap.set(sessionId, state);
}

/**
 * Wait for the session's current tracker to finish tearing down (its `done`
 * event published and its subscription dropped).
 *
 * Returns immediately when no tracker is wired.
 */
export async function waitForPersistenceTeardown(sessionId: string): Promise<void> {
  await persistenceMap.get(sessionId)?.teardown;
}

/**
 * Remove the persistence handler for a session (called on pool eviction).
 */
export function unwireSessionPersistence(sessionId: string): void {
  const state = persistenceMap.get(sessionId);
  if (state) {
    state.dispose();
    persistenceMap.delete(sessionId);
  }
}
