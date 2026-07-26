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
  sessions.set(getKey(userId, telegramChatId), { session, done });
}

/** Unregister a session (generation complete or aborted). */
export function unregisterTelegramSession(userId: string, telegramChatId: bigint): void {
  sessions.delete(getKey(userId, telegramChatId));
}

/**
 * Abort an active session and wait for it to finish.
 *
 * Returns immediately if no active session. On timeout, force-removes
 * the entry so the new message is not blocked indefinitely.
 */
export async function abortTelegramSession(userId: string, telegramChatId: bigint): Promise<void> {
  const entry = sessions.get(getKey(userId, telegramChatId));
  if (!entry) return;

  // Abort the agent
  entry.session.abort().catch((err) => {
    console.error("Telegram session abort failed:", err);
  });

  // Unregister immediately so we don't double-abort
  sessions.delete(getKey(userId, telegramChatId));

  // Wait for completion with timeout
  await Promise.race([entry.done, new Promise((resolve) => setTimeout(resolve, ABORT_TIMEOUT_MS))]);
}

/**
 * Graceful shutdown — abort all active sessions.
 * Call during process shutdown.
 */
export function shutdownTelegramSessions(): void {
  for (const [key, entry] of sessions) {
    entry.session.abort().catch((err) => {
      console.error("Telegram session shutdown abort failed:", err);
    });
    sessions.delete(key);
  }
}
