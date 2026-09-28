import type { AgentSession } from "@earendil-works/pi-coding-agent";

/**
 * In-memory registry for active Telegram agent runs.
 *
 * Two responsibilities:
 *
 * 1. **Interrupt on new message** — when a new message arrives while a
 *    generation is running, the old session is aborted and the new message
 *    is processed immediately.
 *
 * 2. **Latest message wins for bursts** — each incoming message gets a
 *    monotonically increasing sequence number for its chat. A run checks
 *    `isLatestMessage()` when it starts (after taking the chat lock) and
 *    again right before prompting, so messages superseded while queued
 *    behind the chat lock drop out instead of each running to completion
 *    and sending their own reply.
 *
 * Runs register in two stages: `beginTelegramRun()` when the run starts
 * (the Pi session does not exist yet — setup takes seconds) and
 * `attachTelegramSession()` once the session is created. An interrupt
 * during the first stage cannot abort anything; the run notices its
 * supersession at the pre-prompt checkpoint and bails on its own.
 *
 * Key: `${userId}:${telegramChatId}` (matches the Telegram chat identity).
 *
 * Process-local only — Telegram webhooks are sequential per chat so no
 * cross-process coordination is needed.
 */

interface RegisteredRun {
  /** The Pi session once created (null during the slow pre-session setup). */
  session: AgentSession | null;
  /** Resolves when the run has fully settled (success, error, abort, supersession). */
  done: Promise<void>;
  /** True once `interruptTelegramChat` interrupted this run. */
  interrupted: boolean;
}

const runs = new Map<string, RegisteredRun>();
/** Latest message sequence per chat — bumped by the webhook per incoming message. */
const latestSeq = new Map<string, number>();

const ABORT_TIMEOUT_MS = 30_000;

function getKey(userId: string, telegramChatId: bigint): string {
  return `${userId}:${telegramChatId}`;
}

/**
 * Bump and return the message sequence for a chat.
 * The webhook calls this once per incoming message, before processing, so a
 * run can later tell whether a newer message superseded it.
 */
export function nextMessageSeq(userId: string, telegramChatId: bigint): number {
  const key = getKey(userId, telegramChatId);
  const seq = (latestSeq.get(key) ?? 0) + 1;
  latestSeq.set(key, seq);
  return seq;
}

/**
 * Whether `seq` is still the latest message for the chat.
 * A run is superseded the moment any newer message for its chat arrives.
 */
export function isLatestMessage(userId: string, telegramChatId: bigint, seq: number): boolean {
  return latestSeq.get(getKey(userId, telegramChatId)) === seq;
}

/** Check if a chat has an active run (including pre-session setup). */
export function isTelegramSessionActive(userId: string, telegramChatId: bigint): boolean {
  return runs.has(getKey(userId, telegramChatId));
}

/**
 * Register a run as the chat's active run when it starts (after the chat
 * lock is acquired), before the Pi session exists. Overwrites the leftover
 * entry of an earlier, already-settled run for the same chat.
 */
export function beginTelegramRun(
  userId: string,
  telegramChatId: bigint,
  done: Promise<void>,
): void {
  runs.set(getKey(userId, telegramChatId), { session: null, done, interrupted: false });
}

/**
 * Attach the Pi session once created (makes the run interruptible
 * mid-generation). No-op if the run's entry was already replaced.
 */
export function attachTelegramSession(
  userId: string,
  telegramChatId: bigint,
  session: AgentSession,
): void {
  const entry = runs.get(getKey(userId, telegramChatId));
  if (entry) {
    entry.session = session;
  }
}

/**
 * Remove this chat's run entry unconditionally.
 *
 * Used by a run that bailed out at a supersession checkpoint: the chat lock
 * guarantees the entry belongs to that run (no other run can be active for
 * the chat), and there is nothing left to interrupt — the entry must not
 * linger as "active" if the superseding message never starts a run.
 */
export function clearTelegramRun(userId: string, telegramChatId: bigint): void {
  runs.delete(getKey(userId, telegramChatId));
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
  const entry = runs.get(key);
  if (entry && entry.session === session) {
    runs.delete(key);
  }
}

/** Whether the given session was interrupted via `interruptTelegramChat`. */
export function wasTelegramSessionInterrupted(session: AgentSession): boolean {
  for (const entry of runs.values()) {
    if (entry.session === session) {
      return entry.interrupted;
    }
  }
  return false;
}

/**
 * Supersede the chat's active run (if any) and wait for it to finish.
 *
 * - Marks the run interrupted (it reports "cancelled" and sends no reply).
 * - Aborts the Pi session if it exists. A run still in pre-session setup
 *   (`session: null`) cannot be aborted — it notices its supersession at the
 *   pre-prompt checkpoint and bails on its own, settling `done`.
 * - Waits for the run to settle, giving up after ABORT_TIMEOUT_MS so a stuck
 *   predecessor cannot block the new message indefinitely.
 *
 * The entry is kept (marked `interrupted`) rather than deleted: a message
 * arriving while the abort is still settling sees the dying run and awaits
 * the same completion promise. The new run's `beginTelegramRun()` overwrites
 * the entry when it starts.
 */
export async function interruptTelegramChat(userId: string, telegramChatId: bigint): Promise<void> {
  const entry = runs.get(getKey(userId, telegramChatId));
  if (!entry) return;

  // Mark + abort the agent. abort() is idempotent, so a second message
  // during the settling window is harmless.
  entry.interrupted = true;
  entry.session?.abort().catch((err) => {
    console.error("Telegram session abort failed:", err);
  });

  // Wait for completion with a timeout; clear the timer so a settled run
  // doesn't keep it alive (a burst creates one waiter per message).
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ABORT_TIMEOUT_MS);
  });
  try {
    await Promise.race([entry.done, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Graceful shutdown — abort all active sessions.
 * Call during process shutdown.
 */
export function shutdownTelegramSessions(): void {
  for (const entry of runs.values()) {
    entry.interrupted = true;
    entry.session?.abort().catch((err) => {
      console.error("Telegram session shutdown abort failed:", err);
    });
  }
  runs.clear();
}
