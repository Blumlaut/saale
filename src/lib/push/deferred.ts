/**
 * The phone wave of a notification.
 *
 * A notification reaches the computers at once and the phones a few minutes
 * later, so a device that shows it in the meantime can take the phone's copy
 * back. The delay is a queued job; whether the notification was seen is decided
 * when it comes due (see `./seen`).
 */
import { getQueue } from "@/lib/queue";
import { getMobilePushDelayMs } from "./config";
import type { PushPayload } from "./send";

/** Job name of a delayed phone push. */
export const MOBILE_PUSH_JOB_NAME = "push_mobile";

/** What a queued phone push carries. */
export interface PendingMobilePush {
  userId: string;
  payload: PushPayload;
  /** When the notification was queued, which is what a "seen" report beats. */
  queuedAt: number;
}

/**
 * BullMQ job id of a pending phone push, one per notification tag.
 *
 * One id per tag keeps the collapse the payload asks for: a second notification
 * with the same tag replaces the pending one instead of stacking behind it.
 */
function mobilePushJobId(userId: string, tag: string): string {
  return `push-mobile-${userId}-${tag}`;
}

/**
 * Queue the phones' copy of a notification.
 *
 * Re-queueing a tag that is still waiting only updates what it will say, so the
 * device hears the newest text on the timer the first notification started.
 */
export async function scheduleMobilePush(userId: string, payload: PushPayload): Promise<void> {
  const queue = getQueue();
  const jobId = mobilePushJobId(userId, payload.tag);
  const pending = await queue.getJob(jobId);

  if (pending) {
    const data: PendingMobilePush = {
      userId,
      payload,
      queuedAt: (pending.data as Partial<PendingMobilePush>).queuedAt ?? Date.now(),
    };

    try {
      await pending.updateData(data);
      return;
    } catch (err) {
      console.error(`Failed to update the pending phone push ${jobId}, queueing a new one:`, err);
    }
  }

  await queue.add(
    MOBILE_PUSH_JOB_NAME,
    { userId, payload, queuedAt: Date.now() },
    {
      jobId,
      delay: getMobilePushDelayMs(),
      removeOnComplete: true,
      removeOnFail: 100,
    },
  );
}
