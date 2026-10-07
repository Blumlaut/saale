import { getRedis } from "@/lib/redis";

/**
 * Time-boxed "auto-approve every tool call" mode (the `/stfu` command, on both
 * the web chat and the Telegram bot).
 *
 * When active for a user, the tool approval gate auto-accepts every tool
 * call that would otherwise require approval ("ask" policy, and risky
 * commands under the "auto" policy) without asking. Tools disabled with
 * the "off" policy stay disabled — STFU never re-enables them.
 * The flag lives in Redis with a TTL equal to the window, so it expires
 * automatically and works across processes/restarts.
 */

/** Redis key prefix for the auto-approve flag. */
const AUTO_APPROVE_PREFIX = "saale:auto-approve:";

/** Default window for /stfu (2 hours). */
export const STFU_DURATION_MS = 2 * 60 * 60 * 1000;

const autoApproveKey = (userId: string) => `${AUTO_APPROVE_PREFIX}${userId}`;

/**
 * Enable auto-approve mode for a user.
 *
 * @param durationMs - Window length (defaults to 2 hours).
 * @returns The expiry timestamp (epoch ms) the mode will last until.
 */
export async function enableAutoApprove(
  userId: string,
  durationMs: number = STFU_DURATION_MS,
): Promise<number> {
  const expiresAt = Date.now() + durationMs;
  const redis = getRedis();
  try {
    await redis.setex(autoApproveKey(userId), Math.ceil(durationMs / 1000), String(expiresAt));
  } catch (err) {
    console.error(`Failed to enable auto-approve for user ${userId}:`, err);
  }
  return expiresAt;
}

/** Cancel auto-approve mode early (e.g. /stfu stop). */
export async function disableAutoApprove(userId: string): Promise<void> {
  const redis = getRedis();
  try {
    await redis.del(autoApproveKey(userId));
  } catch (err) {
    console.error(`Failed to disable auto-approve for user ${userId}:`, err);
  }
}

/**
 * Get the auto-approve expiry timestamp for a user, or null when inactive.
 * The Redis TTL does the real expiry work — the stored value is only used
 * to surface the exact end time to the user.
 */
export async function getAutoApproveExpiry(userId: string): Promise<number | null> {
  const redis = getRedis();
  try {
    const raw = await redis.get(autoApproveKey(userId));
    if (!raw) return null;
    const expiry = Number(raw);
    return Number.isFinite(expiry) ? expiry : null;
  } catch (err) {
    console.error(`Failed to read auto-approve flag for user ${userId}:`, err);
    return null;
  }
}

/**
 * True while auto-approve mode is active for the user.
 *
 * Fails closed: a Redis error logs and returns false (normal approval
 * flow continues) rather than silently auto-approving tools.
 */
export async function isAutoApproveActive(userId: string): Promise<boolean> {
  const expiry = await getAutoApproveExpiry(userId);
  return expiry !== null && expiry > Date.now();
}
