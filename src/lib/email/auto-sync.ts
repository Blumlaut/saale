import { prisma } from "@/lib/db";
import { syncQueueTaskSchedule, unscheduleQueueTask } from "@/lib/queue";

/**
 * Cron expression for the auto-created mailbox refresh job (every minute).
 */
export const MAILBOX_REFRESH_CRON = "* * * * *";

/**
 * Distinguish the auto-created refresh job from user-created email_sync jobs
 * so PATCH/DELETE on the account only touches its own job. Users may still
 * create their own separate email_sync jobs for the same account.
 */
const AUTO_SYNC_TYPE_PREFIX = "email_sync";

function autoSyncJobName(accountId: string): string {
  return `mailbox-refresh:${accountId}`;
}

/**
 * Create the auto-sync (mailbox refresh) job for a newly-added email account.
 * Scopes the config to the account so only that mailbox is refreshed.
 */
export async function createMailboxRefreshJob(userId: string, accountId: string): Promise<void> {
  const job = await prisma.queueTask.create({
    data: {
      userId,
      name: autoSyncJobName(accountId),
      type: AUTO_SYNC_TYPE_PREFIX,
      enabled: true,
      config: JSON.stringify({ cronExpression: MAILBOX_REFRESH_CRON, accountId }),
    },
  });

  await syncQueueTaskSchedule(job).catch((err: unknown) => {
    console.error(`Failed to schedule mailbox refresh job ${job.id}:`, err);
  });
}

/**
 * Enable or disable an account's auto-sync job (bulk update, scoped to user as
 * defense in depth) and resync its BullMQ schedule.
 */
export async function setMailboxRefreshJobEnabled(
  userId: string,
  accountId: string,
  enabled: boolean,
): Promise<void> {
  const jobs = await prisma.queueTask.updateMany({
    where: { userId, name: autoSyncJobName(accountId) },
    data: { enabled },
  });

  if (jobs.count > 0) {
    await syncAccountRefreshSchedules(userId, accountId);
  }
}

/**
 * Resync BullMQ schedules for an account's auto-sync jobs.
 */
async function syncAccountRefreshSchedules(userId: string, accountId: string): Promise<void> {
  const jobs = await prisma.queueTask.findMany({
    where: {
      userId,
      type: AUTO_SYNC_TYPE_PREFIX,
      config: { contains: accountId },
    },
    select: { id: true, type: true, enabled: true, modelId: true, config: true },
  });

  for (const job of jobs) {
    try {
      await syncQueueTaskSchedule(job);
    } catch (err) {
      console.error(`Failed to resync mailbox refresh job ${job.id}:`, err);
    }
  }
}

/**
 * Remove an account's auto-sync job (deletes the QueueTask, which also
 * removes its BullMQ scheduler). Scoped to user as defense in depth.
 */
export async function deleteMailboxRefreshJob(userId: string, accountId: string): Promise<void> {
  const jobs = await prisma.queueTask.findMany({
    where: {
      userId,
      name: autoSyncJobName(accountId),
      type: AUTO_SYNC_TYPE_PREFIX,
    },
    select: { id: true },
  });

  for (const job of jobs) {
    await unscheduleQueueTask(job.id);
    await prisma.queueTask.deleteMany({ where: { id: job.id, userId } });
  }
}
