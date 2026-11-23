import { getRedis } from "@/lib/redis";

/**
 * "Auto-approve every tool call" mode (the `/stfu` command, on both the web
 * chat and the Telegram bot).
 *
 * While it is on for a chat, the tool approval gate auto-accepts every tool
 * call that would otherwise require approval ("ask" policy, and risky
 * commands under the "auto" policy) without asking. Tools disabled with
 * the "off" policy stay disabled. STFU never re-enables them.
 *
 * The flag lives in Redis under the chat it was set in, so saying "no
 * questions" in one conversation leaves the rest of the account asking. It
 * carries a TTL for a time box and none when the mode is permanent, so it
 * works across processes and restarts.
 */

/** Redis key prefix for the auto-approve flag. */
const AUTO_APPROVE_PREFIX = "saale:auto-approve:";

/** Default window for /stfu (2 hours). */
export const STFU_DURATION_MS = 2 * 60 * 60 * 1000;

/** Stored value for a mode that stays on until the user turns it off. */
const PERMANENT = "permanent";

const autoApproveKey = (userId: string, sessionId: string) =>
  `${AUTO_APPROVE_PREFIX}${userId}:${sessionId}`;

/**
 * Enable auto-approve mode for one chat.
 *
 * @param durationMs - Window length (defaults to 2 hours), or null to keep the
 *   mode on until it is turned off.
 * @returns The expiry timestamp (epoch ms) for a window, null for permanent.
 */
export async function enableAutoApprove(
  userId: string,
  sessionId: string,
  durationMs: number | null = STFU_DURATION_MS,
): Promise<number | null> {
  const redis = getRedis();
  try {
    if (durationMs === null) {
      // No TTL. the key lives until disableAutoApprove removes it.
      await redis.set(autoApproveKey(userId, sessionId), PERMANENT);
      return null;
    }
    const expiresAt = Date.now() + durationMs;
    await redis.setex(
      autoApproveKey(userId, sessionId),
      Math.ceil(durationMs / 1000),
      String(expiresAt),
    );
    return expiresAt;
  } catch (err) {
    console.error(`Failed to enable auto-approve for chat ${sessionId}:`, err);
    return durationMs === null ? null : Date.now() + durationMs;
  }
}

/** Cancel auto-approve mode early (e.g. /stfu stop). */
export async function disableAutoApprove(userId: string, sessionId: string): Promise<void> {
  const redis = getRedis();
  try {
    await redis.del(autoApproveKey(userId, sessionId));
  } catch (err) {
    console.error(`Failed to disable auto-approve for chat ${sessionId}:`, err);
  }
}

/** The mode's state for one chat. `expiresAt` is null while it is permanent. */
export interface AutoApproveStatus {
  expiresAt: number | null;
}

/** A status read, classified at the current time. */
export type AutoApproveState =
  { kind: "off" } | { kind: "window"; until: number } | { kind: "permanent" };

/**
 * Get the auto-approve state for a chat, or null when inactive.
 * The Redis TTL does the real expiry work. the stored value is only used
 * to surface the exact end time to the user.
 */
export async function getAutoApproveStatus(
  userId: string,
  sessionId: string,
): Promise<AutoApproveStatus | null> {
  const redis = getRedis();
  try {
    const raw = await redis.get(autoApproveKey(userId, sessionId));
    if (!raw) return null;
    if (raw === PERMANENT) return { expiresAt: null };
    const expiresAt = Number(raw);
    return Number.isFinite(expiresAt) ? { expiresAt } : null;
  } catch (err) {
    console.error(`Failed to read the auto-approve flag of chat ${sessionId}:`, err);
    return null;
  }
}

/**
 * True while auto-approve mode is active for the chat.
 *
 * Fails closed: a Redis error logs and returns false (normal approval
 * flow continues) rather than silently auto-approving tools.
 */
export async function isAutoApproveActive(userId: string, sessionId: string): Promise<boolean> {
  return autoApproveState(await getAutoApproveStatus(userId, sessionId)).kind !== "off";
}

/** Classify a status read at the current time. */
export function autoApproveState(status: AutoApproveStatus | null): AutoApproveState {
  if (status === null) return { kind: "off" };
  if (status.expiresAt === null) return { kind: "permanent" };
  return status.expiresAt > Date.now()
    ? { kind: "window", until: status.expiresAt }
    : { kind: "off" };
}
