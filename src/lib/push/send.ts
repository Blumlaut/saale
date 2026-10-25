/**
 * Web Push delivery.
 *
 * Every notification the product sends ends up here: `notifyUser` decides
 * whether the user wants it, this module puts it on the wire. A push service
 * answers 404/410 for a subscription the browser has thrown away, which is the
 * only signal Saale gets that a device is gone, so that is what prunes the row.
 */
import webpush from "web-push";
import { prisma } from "@/lib/db";
import { getVapidConfig } from "./config";

/**
 * How long the push service may hold an undelivered message. A phone that was
 * offline overnight should not wake up to a reminder for an event that has
 * already passed, so messages expire instead of queueing indefinitely.
 */
const PUSH_TTL_SECONDS = 60 * 60;

/** The payload the service worker renders. */
export interface PushPayload {
  title: string;
  body: string;
  /** Path the notification opens when clicked. */
  url: string;
  /** Collapse key: a newer notification with the same tag replaces the older one. */
  tag: string;
}

export interface PushDelivery {
  /** Devices the push service accepted the message for. */
  sent: number;
  /** Subscriptions that no longer exist and were removed. */
  pruned: number;
  /** Devices that could not be reached. Logged, never thrown. */
  failed: number;
}

/** Push service status codes that mean "this subscription is dead". */
const GONE_STATUS_CODES = new Set([404, 410]);

let vapidConfiguredFor: string | null = null;

/**
 * Hand the key pair to web-push once per process (and again if the keys
 * change, which only happens between restarts).
 */
function configureWebPush(vapid: { publicKey: string; privateKey: string; subject: string }): void {
  if (vapidConfiguredFor === vapid.publicKey) return;
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  vapidConfiguredFor = vapid.publicKey;
}

/** Status code of a web-push failure, when it carries one. */
function statusCodeOf(error: unknown): number | undefined {
  if (error && typeof error === "object" && "statusCode" in error) {
    const code = (error as { statusCode?: unknown }).statusCode;
    if (typeof code === "number") return code;
  }
  return undefined;
}

/**
 * Send one notification to every device the user has subscribed.
 *
 * Never throws: a push service rejecting a device must not fail the job or the
 * chat turn that produced the notification. Inspect the result instead.
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<PushDelivery> {
  const delivery: PushDelivery = { sent: 0, pruned: 0, failed: 0 };

  const vapid = getVapidConfig();
  if (!vapid) return delivery;

  const subscriptions = await prisma.pushSubscription.findMany({
    where: { userId },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });
  if (subscriptions.length === 0) return delivery;

  configureWebPush(vapid);
  const body = JSON.stringify(payload);

  // Sent in parallel: a user with several devices waits on the slowest push
  // service once, rather than once per device.
  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          body,
          { TTL: PUSH_TTL_SECONDS },
        );
        delivery.sent++;
      } catch (err) {
        const status = statusCodeOf(err);
        if (status !== undefined && GONE_STATUS_CODES.has(status)) {
          delivery.pruned++;
          await prisma.pushSubscription
            .deleteMany({ where: { id: subscription.id, userId } })
            .catch((error) => {
              console.error(`Failed to prune push subscription ${subscription.id}:`, error);
            });
          return;
        }

        delivery.failed++;
        console.error(
          `Failed to send push to subscription ${subscription.id} (${status ?? "no status"}):`,
          err,
        );
      }
    }),
  );

  return delivery;
}

/** Send a notification to one device, for the settings "test" button. */
export async function sendPushToSubscription(
  subscriptionId: string,
  payload: PushPayload,
): Promise<boolean> {
  const vapid = getVapidConfig();
  if (!vapid) return false;

  const subscription = await prisma.pushSubscription.findUnique({
    where: { id: subscriptionId },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });
  if (!subscription) return false;

  configureWebPush(vapid);

  try {
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      JSON.stringify(payload),
      { TTL: PUSH_TTL_SECONDS },
    );
    return true;
  } catch (err) {
    const status = statusCodeOf(err);
    if (status !== undefined && GONE_STATUS_CODES.has(status)) {
      await prisma.pushSubscription
        .deleteMany({ where: { id: subscription.id } })
        .catch((error) => {
          console.error(`Failed to prune push subscription ${subscription.id}:`, error);
        });
      return false;
    }

    console.error(
      `Failed to send test push to subscription ${subscription.id} (${status ?? "no status"}):`,
      err,
    );
    return false;
  }
}
