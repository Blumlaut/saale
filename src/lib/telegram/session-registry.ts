import type { AgentSession } from "@earendil-works/pi-coding-agent";

/**
 * In-memory registry for active Telegram agent sessions.
 *
 * Enables interrupting an ongoing generation when a new message arrives —
 * the old session is aborted and the new message is processed immediately.
 *
 * Key: `${userId}:${telegramChatId}` (matches the Telegram chat identity).
 *
 * Process-local only — Telegram webhooks are sequential per chat so no
 * cross-process coordination is needed.
 */

interface RegisteredSession {
  session: AgentSession;
  done: Promise<void>;
  /** True once `abortTelegramSession` interrupted this run. */
  interrupted: boolean;
}

const sessions = new Map<string, RegisteredSession>();

const ABORT_TIMEOUT_MS = 30_000;

function getKey(userId: string, telegramChatId: bigint): string {
  return `${userId}:${telegramChatId}`;
}

/** Check if a chat has an active generation. */
export function isTelegramSessionActive(userId: string, telegramChatId: bigint): boolean {
  return sessions.has(getKey(userId, telegramChatId));
}

/** Register a session and its completion promise. */
export function registerTelegramSession(
  userId: string,
  telegramChatId: bigint,
  session: AgentSession,
  done: Promise<void>,
): void {
  sessions.set(getKey(userId, telegramChatId), { session, done, interrupted: false });
}

/**
 * Unregister a session (generation complete or aborted).
 *
 * Identity-checked: only removes the entry if it still belongs to THIS
 * session. When a run is interrupted, the new run may register under the
 * same chat key before the old run's cleanup executes — the old run's
 * late unregister must not delete the new run's entry.
 */
export function unregisterTelegramSession(
  userId: string,
  telegramChatId: bigint,
  session: AgentSession,
): void {
  const key = getKey(userId, telegramChatId);
  const entry = sessions.get(key);
  if (entry && entry.session === session) {
    sessions.delete(key);
  }
}

/** Whether the given session was interrupted via `abortTelegramSession`. */
export function wasTelegramSessionInterrupted(session: AgentSession): boolean {
  for (const entry of sessions.values()) {
    if (entry.session === session) {
      return entry.interrupted;
    }
  }
  return false;
}

/**
 * Abort an active session and wait for it to finish.
 *
 * Returns immediately if no active session. On timeout, the wait gives up
 * (the dying run finishes in the background) so the new message is not
 * blocked indefinitely.
 *
 * The entry is kept (marked `interrupted`) rather than deleted: a message
 * arriving while the abort is still settling sees the dying run and awaits
 * the same completion promise. The new run's `registerTelegramSession()`
 * overwrites the entry when it starts.
 */
export async function abortTelegramSession(userId: string, telegramChatId: bigint): Promise<void> {
  const entry = sessions.get(getKey(userId, telegramChatId));
  if (!entry) return;

  // Mark + abort the agent. abort() is idempotent, so a second message
  // during the settling window is harmless.
  entry.interrupted = true;
  entry.session.abort().catch((err) => {
    console.error("Telegram session abort failed:", err);
  });

  // Wait for completion with timeout
  await Promise.race([entry.done, new Promise((resolve) => setTimeout(resolve, ABORT_TIMEOUT_MS))]);
}

/**
 * Graceful shutdown — abort all active sessions.
 * Call during process shutdown.
 */
export function shutdownTelegramSessions(): void {
  for (const [, entry] of sessions) {
    entry.interrupted = true;
    entry.session.abort().catch((err) => {
      console.error("Telegram session shutdown abort failed:", err);
    });
  }
  sessions.clear();
}
