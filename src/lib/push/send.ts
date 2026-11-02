/**
 * Web Push delivery.
 *
 * Every notification the product sends ends up here: `notifyUser` decides
 * whether the user wants it, this module puts it on the wire. A push service
 * answers 404/410 for a subscription the browser has thrown away, which is the
 * only signal Saale gets that a device is gone, so that is what prunes the row.
 *
 * Delivery is two waves. A computer's copy goes out at once; a phone's waits a
 * few minutes in the queue (`./deferred`), long enough for a computer that
 * showed the notification to take it back.
 */
import webpush from "web-push";
import { prisma } from "@/lib/db";
import { getVapidConfig, getMobilePushDelayMs } from "./config";
import { scheduleMobilePush } from "./deferred";
import { wasPushSeenSince } from "./seen";

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
  /** Phones whose copy is waiting for a computer to see the notification first. */
  deferred: number;
  /** Phones left alone because the notification was already on screen. */
  skipped: number;
  /** Subscriptions that no longer exist and were removed. */
  pruned: number;
  /** Devices that could not be reached. Logged, never thrown. */
  failed: number;
}

export interface SendPushOptions {
  /** Send to phones at once, for a notification nobody can cancel. */
  deferMobile?: boolean;
}

/** A stored subscription, as delivery needs it. */
interface Subscriber {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
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

/** The subscriptions of one wave, with what delivery needs from each. */
const SUBSCRIBER_FIELDS = { id: true, endpoint: true, p256dh: true, auth: true } as const;

/**
 * Send one payload to a set of devices, counting what happened.
 *
 * Never throws: a push service rejecting a device must not fail the job or the
 * chat turn that produced the notification.
 */
async function deliver(
  userId: string,
  subscribers: Subscriber[],
  body: string,
  delivery: PushDelivery,
): Promise<void> {
  // Sent in parallel: a user with several devices waits on the slowest push
  // service once, rather than once per device.
  await Promise.all(
    subscribers.map(async (subscription) => {
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
}

/**
 * Send one notification to the user's devices.
 *
 * The computers get it now. The phones get it a few minutes later, and only if
 * no computer saw it first. A user without a computer is not made to wait for
 * one, and a queue that will not take the delayed job sends the phones their
 * copy now rather than losing it.
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
  options: SendPushOptions = {},
): Promise<PushDelivery> {
  const delivery: PushDelivery = { sent: 0, deferred: 0, skipped: 0, pruned: 0, failed: 0 };

  const vapid = getVapidConfig();
  if (!vapid) return delivery;

  const subscriptions = await prisma.pushSubscription.findMany({
    where: { userId },
    select: { ...SUBSCRIBER_FIELDS, deviceKind: true },
  });
  if (subscriptions.length === 0) return delivery;

  const phones = subscriptions.filter((subscription) => subscription.deviceKind === "mobile");
  const computers = subscriptions.filter((subscription) => subscription.deviceKind !== "mobile");

  let immediate: Subscriber[] = subscriptions;
  if (options.deferMobile !== false && phones.length > 0 && computers.length > 0) {
    try {
      await scheduleMobilePush(userId, payload);
      immediate = computers;
      delivery.deferred = phones.length;
    } catch (err) {
      console.error(`Failed to queue the phone push for user ${userId}, sending it now:`, err);
    }
  }

  configureWebPush(vapid);
  await deliver(userId, immediate, JSON.stringify(payload), delivery);

  return delivery;
}

/**
 * The phones' copy, once the delay has passed.
 *
 * Called from the worker for the job `scheduleMobilePush` queued. Nothing is
 * sent when the notification's page has been on screen since it was queued: the
 * user has read what it was about.
 */
export async function sendDeferredPush(
  userId: string,
  payload: PushPayload,
  queuedAt: number = Date.now() - getMobilePushDelayMs(),
): Promise<PushDelivery> {
  const delivery: PushDelivery = { sent: 0, deferred: 0, skipped: 0, pruned: 0, failed: 0 };

  const vapid = getVapidConfig();
  if (!vapid) return delivery;

  // Read again: a phone may have turned notifications off in the meantime.
  const phones = await prisma.pushSubscription.findMany({
    where: { userId, deviceKind: "mobile" },
    select: SUBSCRIBER_FIELDS,
  });
  if (phones.length === 0) return delivery;

  if (await wasPushSeenSince(userId, payload.url, queuedAt)) {
    delivery.skipped = phones.length;
    return delivery;
  }

  configureWebPush(vapid);
  await deliver(userId, phones, JSON.stringify(payload), delivery);

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
    select: SUBSCRIBER_FIELDS,
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
