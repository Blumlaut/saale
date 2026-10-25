/**
 * The one entry point for reaching a user outside the app.
 *
 * A caller says what happened and which category it belongs to; this decides
 * whether the user wants it (their notification settings) and which channels
 * carry it (push to every subscribed device, plus the in-app bell for events
 * that happened in the background).
 *
 * Nothing here throws: a notification is a side effect of work that already
 * completed, so a push service or Redis outage must not fail it.
 */
import { prisma } from "@/lib/db";
import { isPushConfigured } from "@/lib/push/config";
import { sendPushToUser } from "@/lib/push/send";
import { addInboxNotification } from "./inbox";
import { isCategoryEnabled, type NotificationCategory } from "./preferences";

export interface UserNotification {
  userId: string;
  category: NotificationCategory;
  title: string;
  body: string;
  /** In-app path the notification opens when tapped. */
  url: string;
  /** Collapse key: a newer notification with the same tag replaces the older one. */
  tag: string;
  /** Also list it in the in-app bell. Off for events the chat UI already shows. */
  inApp?: boolean;
}

/** Whether this user wants this category at all. */
export async function isNotificationWanted(
  userId: string,
  category: NotificationCategory,
): Promise<boolean> {
  if (!isPushConfigured()) return false;

  const settings = await prisma.appSettings.findUnique({
    where: { userId },
    select: { pushNotifications: true },
  });

  return isCategoryEnabled(settings?.pushNotifications ?? null, category);
}

/**
 * Push a notification to the user's devices, and optionally list it in the
 * bell. Silently does nothing when the instance has no VAPID keys or the user
 * turned the category off.
 */
export async function notifyUser(notification: UserNotification): Promise<void> {
  const { userId, category, title, body, url, tag, inApp = false } = notification;

  try {
    if (!(await isNotificationWanted(userId, category))) return;

    if (inApp) {
      await addInboxNotification(userId, {
        type: category,
        title,
        message: body,
        data: { url },
      }).catch((err) => {
        console.error(`Failed to add in-app notification for user ${userId}:`, err);
      });
    }

    await sendPushToUser(userId, { title, body, url, tag });
  } catch (err) {
    console.error(`Failed to notify user ${userId} (${category}):`, err);
  }
}
