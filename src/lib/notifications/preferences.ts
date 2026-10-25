/**
 * Which push notifications a user wants, and what each one covers.
 *
 * Stored sparsely on `AppSettings.pushNotifications` (`{ "email": false }`), so
 * a category nobody turned off leaves no column entry and the defaults live
 * here.
 */

/** The kinds of event that can reach a device. */
export const NOTIFICATION_CATEGORIES = [
  {
    key: "chatDone",
    label: "Chat finished",
    description: "A chat reply finished while you were away from the conversation.",
  },
  {
    key: "coderDone",
    label: "Coder finished",
    description: "A coder chat finished its turn in one of your projects.",
  },
  {
    key: "calendar",
    label: "Calendar events",
    description: "An event is about to start.",
  },
  {
    key: "email",
    label: "New mail",
    description: "New mail arrived in one of your inboxes.",
  },
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]["key"];

export type NotificationPreferences = Record<NotificationCategory, boolean>;

/** Everything is on until the user turns it off. */
const DEFAULT_ENABLED = true;

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  chatDone: DEFAULT_ENABLED,
  coderDone: DEFAULT_ENABLED,
  calendar: DEFAULT_ENABLED,
  email: DEFAULT_ENABLED,
};

function isCategory(value: string): value is NotificationCategory {
  return NOTIFICATION_CATEGORIES.some((category) => category.key === value);
}

/**
 * The full set of preferences, with defaults filled in. A malformed or absent
 * column reads as "everything on".
 */
export function readNotificationPreferences(value: unknown): NotificationPreferences {
  const stored = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const result = { ...DEFAULT_NOTIFICATION_PREFERENCES };

  for (const [key, entry] of Object.entries(stored as Record<string, unknown>)) {
    if (!isCategory(key) || typeof entry !== "boolean") continue;
    result[key] = entry;
  }

  return result;
}

/**
 * Canonical `pushNotifications`: known categories only, and only the entries
 * that differ from the default, so the column stays empty for a user who never
 * changed anything.
 */
export function normalizeNotificationPreferences(value: unknown): Partial<NotificationPreferences> {
  const stored = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const result: Partial<NotificationPreferences> = {};

  for (const [key, entry] of Object.entries(stored as Record<string, unknown>)) {
    if (!isCategory(key) || typeof entry !== "boolean") continue;
    if (entry === DEFAULT_ENABLED) continue;
    result[key] = entry;
  }

  return result;
}

/** Whether one category is enabled, given the stored column value. */
export function isCategoryEnabled(value: unknown, category: NotificationCategory): boolean {
  return readNotificationPreferences(value)[category];
}
