/**
 * Where the user last had a notification's page on screen.
 *
 * A notification's phones' copy waits a few minutes. A device showing the page
 * it is about in that window means it was seen, so the waiting copy is dropped
 * instead of buzzing a phone about news the user is reading.
 *
 * Keyed by user and path: any device counts, and the path is what a page and a
 * notification have in common.
 */
import { getRedis } from "@/lib/redis";

/** Longer than the queue holds a notification, so a report outlives the wait. */
const SEEN_TTL_SECONDS = 15 * 60;

const SEEN_PREFIX = "push:seen:";

/** Reads a relative path the same way it reads an absolute URL. */
const BASE_URL = "http://saale.invalid";

/** A path from a URL or a route: no origin, no query, no trailing slash. */
export function notificationPath(url: string): string {
  try {
    return new URL(url, BASE_URL).pathname.replace(/\/+$/, "") || "/";
  } catch (err) {
    console.error(`Failed to read the path of ${url}:`, err);
    return url;
  }
}

const seenKey = (userId: string, path: string) => `${SEEN_PREFIX}${userId}:${path}`;

/** Record that the user has a notification's page on screen now. */
export async function markPushSeen(userId: string, url: string): Promise<void> {
  try {
    await getRedis().set(
      seenKey(userId, notificationPath(url)),
      String(Date.now()),
      "EX",
      SEEN_TTL_SECONDS,
    );
  } catch (err) {
    console.error(`Failed to record push ${url} as seen for user ${userId}:`, err);
  }
}

/**
 * Whether the page was on screen at or after `since`, a wall-clock timestamp.
 *
 * A timestamp beats a flag: a user who read the page before the notification
 * existed has not seen it.
 */
export async function wasPushSeenSince(
  userId: string,
  url: string,
  since: number,
): Promise<boolean> {
  try {
    const value = await getRedis().get(seenKey(userId, notificationPath(url)));
    if (value === null) return false;

    const seenAt = Number(value);
    return Number.isFinite(seenAt) && seenAt >= since;
  } catch (err) {
    console.error(`Failed to read whether push ${url} was seen by user ${userId}:`, err);
    return false;
  }
}
