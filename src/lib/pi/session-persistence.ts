/**
 * Session-scoped DB persistence for chat agent events.
 *
 * Thin wrapper around SessionEventTracker: wires the shared tracker to a
 * pooled agent session exactly once, and tracks the wiring so pool eviction
 * can tear it down.
 *
 * The SSE stream route is purely an observer — all persistence and stream
 * event publishing happens inside the tracker.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createSessionEventTracker, type SessionEventTracker } from "./session-event-tracker";

/** Per-session persistence state (one entry per pooled session). */
interface PersistenceState {
  dispose: () => void;
}

/** In-memory store: sessionId → persistence state. */
const persistenceMap = new Map<string, PersistenceState>();

/**
 * Wire DB persistence + stream event publishing for a pooled session.
 *
 * Called exactly once when a session enters the pool. All subsequent SSE
 * connections are pure observers — they never trigger writes.
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
  // Guard: only wire once per session
  if (persistenceMap.has(sessionId)) return;

  const tracker: SessionEventTracker = createSessionEventTracker({
    sessionId,
    userId,
    session,
    autoCompact: true,
    onDone: () => {
      persistenceMap.delete(sessionId);
    },
  });

  persistenceMap.set(sessionId, { dispose: () => tracker.dispose() });
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
