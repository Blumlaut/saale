import { prisma } from "@/lib/db";
import { getRedis } from "@/lib/redis";

const NOTIFICATION_KEY = "notifications:";

export const metadata = {
  type: "task_reminders",
  label: "Task Reminders",
  description: "Send notifications for tasks due within 24 hours",
  icon: "Bell",
  defaultCron: "0 8 * * *",
  usesAi: false,
} as const;

export const fields = [];

export async function handler(params: {
  config: Record<string, unknown>;
  userId: string;
  modelId?: string | null;
}) {
  const { userId } = params;
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(23, 59, 59, 999);

  // Find pending tasks due within 24 hours that haven't been notified
  const tasks = await prisma.task.findMany({
    where: {
      userId,
      status: "pending",
      dueDate: { not: null, lte: tomorrow },
      OR: [{ notifiedAt: null }, { notifiedAt: { lt: now } }],
    },
    select: { id: true, title: true, dueDate: true },
  });

  let notificationsSent = 0;
  const redis = getRedis();
  const key = `${NOTIFICATION_KEY}${userId}`;

  for (const task of tasks) {
    const dueDate = new Date(task.dueDate!);
    const isToday =
      dueDate.getDate() === now.getDate() &&
      dueDate.getMonth() === now.getMonth() &&
      dueDate.getFullYear() === now.getFullYear();

    const title = isToday ? `Task due today: ${task.title}` : `Task due tomorrow: ${task.title}`;

    const notification = {
      id: crypto.randomUUID(),
      type: "task_reminder",
      title,
      message: isToday ? "Don't forget this task is due today!" : "This task is due tomorrow.",
      data: { taskId: task.id },
      read: false,
      createdAt: now.toISOString(),
    };

    await redis.lpush(key, JSON.stringify(notification));
    await redis.ltrim(key, 0, 99);
    notificationsSent++;
  }

  // Update notifiedAt for all processed tasks
  if (tasks.length > 0) {
    await prisma.task.updateMany({
      where: {
        id: { in: tasks.map((t) => t.id) },
        userId,
      },
      data: { notifiedAt: now },
    });
  }

  return JSON.stringify({ tasksScanned: tasks.length, notificationsSent });
}
