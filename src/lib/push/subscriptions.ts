/**
 * Push subscription storage. One row per browser that enabled notifications.
 */
import { prisma } from "@/lib/db";

/** What a browser's `PushSubscription` carries that Saale needs. */
export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}

/**
 * Record a browser's subscription, or refresh the keys of one already stored.
 *
 * The endpoint is unique across the table: the browser that signs up again (a
 * new key pair after a cleared cache, or the same device signed in as another
 * account) replaces the row instead of accumulating dead ones.
 */
export async function savePushSubscription(
  userId: string,
  subscription: PushSubscriptionInput,
): Promise<void> {
  const data = {
    userId,
    p256dh: subscription.p256dh,
    auth: subscription.auth,
    userAgent: subscription.userAgent ?? null,
  };

  await prisma.pushSubscription.upsert({
    where: { endpoint: subscription.endpoint },
    create: { endpoint: subscription.endpoint, ...data },
    update: data,
  });
}

/**
 * Remove one browser's subscription. Scoped to the owner, so a signed-in user
 * cannot unsubscribe another account's device.
 */
export async function deletePushSubscription(userId: string, endpoint: string): Promise<void> {
  await prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
}

/** Remove every subscription of a user (the "turn notifications off" switch). */
export async function deleteAllPushSubscriptions(userId: string): Promise<void> {
  await prisma.pushSubscription.deleteMany({ where: { userId } });
}

/** A user's subscribed devices, newest first. */
export async function listPushSubscriptions(
  userId: string,
): Promise<Array<{ id: string; userAgent: string | null; createdAt: Date }>> {
  return prisma.pushSubscription.findMany({
    where: { userId },
    select: { id: true, userAgent: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
}
