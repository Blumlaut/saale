/**
 * The in-app notification list behind the bell, kept in Redis.
 *
 * Separate from push: the bell shows what happened while the user was in the
 * app (or wants a record afterwards), push reaches a device that is not
 * looking. A delivered notification can have one, the other, or both.
 */
import { getRedis } from "@/lib/redis";

const NOTIFICATION_KEY = "notifications:";

/** How many entries the list keeps; older ones fall off the end. */
const MAX_ENTRIES = 100;

export interface InboxNotification {
  type: string;
  title: string;
  message: string;
  data?: Record<string, unknown>;
}

/** An entry as it is stored and as the bell reads it back. */
export interface StoredInboxNotification {
  id: string;
  type: string;
  title: string;
  message: string;
  data: Record<string, unknown>;
  read: boolean;
  createdAt: string;
}

/**
 * Prepend an entry to a user's notification list.
 *
 * Writes the id and timestamp here rather than at the call sites so every
 * entry in the list has the same shape the bell reads.
 */
export async function addInboxNotification(
  userId: string,
  notification: InboxNotification,
): Promise<StoredInboxNotification> {
  const redis = getRedis();
  const key = `${NOTIFICATION_KEY}${userId}`;
  const entry = {
    id: crypto.randomUUID(),
    type: notification.type,
    title: notification.title,
    message: notification.message,
    data: notification.data ?? {},
    read: false,
    createdAt: new Date().toISOString(),
  };

  await redis
    .multi()
    .lpush(key, JSON.stringify(entry))
    .ltrim(key, 0, MAX_ENTRIES - 1)
    .exec();

  return entry;
}

/**
 * Replace a user's whole list, for a write that rewrites every entry (mark read).
 *
 * One round trip: the old copy goes, the new one arrives in the same order it
 * was read in, and the list keeps its cap.
 */
async function replaceInboxNotifications(
  userId: string,
  entries: ReadonlyArray<StoredInboxNotification>,
): Promise<void> {
  const redis = getRedis();
  const key = `${NOTIFICATION_KEY}${userId}`;
  const multi = redis.multi().del(key);
  if (entries.length > 0) {
    multi.rpush(key, ...entries.map((entry) => JSON.stringify(entry)));
    multi.ltrim(key, 0, MAX_ENTRIES - 1);
  }
  await multi.exec();
}

/** A stored entry, or null for a line Redis holds that is not one. */
function parseEntry(raw: string): StoredInboxNotification | null {
  try {
    return JSON.parse(raw) as StoredInboxNotification;
  } catch (err) {
    console.error("Failed to parse a stored notification:", err);
    return null;
  }
}

/** A user's bell, newest first. */
export async function listInboxNotifications(userId: string): Promise<StoredInboxNotification[]> {
  const raw = await getRedis().lrange(`${NOTIFICATION_KEY}${userId}`, 0, MAX_ENTRIES - 1);
  return raw.map((line) => parseEntry(line as string)).filter((entry) => entry !== null);
}

/**
 * Mark entries read, or every entry with `all`.
 *
 * Redis lists are replaced whole rather than edited in place, so this reads the
 * list and writes it back with the same order and cap.
 */
export async function markInboxNotifications(
  userId: string,
  options: { ids?: readonly string[]; all?: boolean },
): Promise<void> {
  const entries = await listInboxNotifications(userId);
  const marked = entries.map((entry) =>
    options.all || options.ids?.includes(entry.id) ? { ...entry, read: true } : entry,
  );

  await replaceInboxNotifications(userId, marked);
}
