import { Queue, Worker, type Job } from "bullmq";
import { prisma } from "@/lib/db";
import { syncEmailAccount } from "@/lib/email/sync";

// ─── Connection ──────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/**
 * Get a BullMQ connection (uses Redis URL string to avoid ioredis version conflicts).
 */
export function getConnection(): string {
  return REDIS_URL;
}

// ─── Queue Registry ──────────────────────────────────────────────────────────

/**
 * Get a BullMQ queue by task ID.
 * Each task gets its own queue for isolation and independent scheduling.
 */
export function getQueue(taskId: string): Queue {
  return new Queue(`saale-task-${taskId}`, {
    connection: getConnection() as any,
  });
}

// ─── Job Run Tracking ────────────────────────────────────────────────────────

export async function addJobRun(
  taskId: string,
  status: "pending" | "running" | "completed" | "error",
  input?: string,
): Promise<{ id: string }> {
  const run = await prisma.taskRun.create({
    data: {
      taskId,
      status,
      ...(input ? { input } : {}),
      startedAt: status === "running" ? new Date() : null,
      completedAt: status === "completed" || status === "error" ? new Date() : null,
    },
  });
  return { id: run.id };
}

export async function updateJobRun(
  runId: string,
  data: {
    status?: "pending" | "running" | "completed" | "error";
    output?: string;
    error?: string;
    startedAt?: Date;
    completedAt?: Date;
  },
): Promise<void> {
  await prisma.taskRun.update({
    where: { id: runId },
    data,
  });
}

// ─── Worker ──────────────────────────────────────────────────────────────────

/**
 * Process a single job execution.
 * This is the handler called by BullMQ workers.
 */
export async function processJob(job: Job): Promise<void> {
  const { taskId, runId, type, ...config } = job.data;

  // Mark run as running
  if (runId) {
    await updateJobRun(runId, { status: "running", startedAt: new Date() });
  }

  try {
    let output: string;

    if (type === "email_sync") {
      const result = await syncEmailAccount(config.accountId);
      output = JSON.stringify(result);
    } else if (type === "summarization") {
      const emails = await prisma.emailMessage.findMany({
        where: {
          accountId: config.accountId,
          isRead: false,
        },
        orderBy: { date: "desc" },
        take: config.limit ?? 10,
        select: {
          id: true,
          subject: true,
          fromEmail: true,
          bodyPreview: true,
          date: true,
        },
      });

      const summaries = emails.map((e) => ({
        id: e.id,
        summary: e.subject
          ? `${e.subject} — ${e.bodyPreview.slice(0, 100)}`
          : e.bodyPreview.slice(0, 100),
      }));

      for (const summary of summaries) {
        await prisma.emailMessage.update({
          where: { id: summary.id },
          data: { aiSummary: summary.summary },
        });
      }

      output = JSON.stringify({
        processed: emails.length,
        summaries,
      });
    } else if (type === "classification") {
      const emails = await prisma.emailMessage.findMany({
        where: {
          accountId: config.accountId,
          isRead: false,
        },
        orderBy: { date: "desc" },
        take: config.limit ?? 10,
        select: {
          id: true,
          subject: true,
          fromEmail: true,
          bodyPreview: true,
          tags: true,
        },
      });

      const classifications = emails.map((email) => {
        const subject = (email.subject ?? "").toLowerCase();
        const body = (email.bodyPreview ?? "").toLowerCase();
        const combined = subject + " " + body;

        const aiTags: string[] = [];
        if (combined.includes("invoice") || combined.includes("receipt")) {
          aiTags.push("finance");
        }
        if (combined.includes("meeting") || combined.includes("calendar")) {
          aiTags.push("schedule");
        }
        if (combined.includes("newsletter") || combined.includes("unsubscribe")) {
          aiTags.push("newsletter");
        }
        if (combined.includes("password") || combined.includes("security")) {
          aiTags.push("security");
        }

        return { id: email.id, tags: email.tags, aiTags };
      });

      for (const classification of classifications) {
        await prisma.emailMessage.update({
          where: { id: classification.id },
          data: {
            tags: Array.from(new Set([...classification.tags, ...classification.aiTags])),
            aiTags: classification.aiTags,
          },
        });
      }

      output = JSON.stringify({
        processed: emails.length,
        classifications,
      });
    } else if (type === "spam_filtering") {
      const emails = await prisma.emailMessage.findMany({
        where: {
          accountId: config.accountId,
          folder: "INBOX",
        },
        orderBy: { date: "desc" },
        take: config.limit ?? 20,
        select: {
          id: true,
          subject: true,
          fromEmail: true,
          bodyPreview: true,
          spamScore: true,
        },
      });

      const spamIndicators = [
        { pattern: /free\s+money/i, score: 0.3 },
        { pattern: /click\s+here/i, score: 0.2 },
        { pattern: /act\s+now/i, score: 0.2 },
        { pattern: /limited\s+time/i, score: 0.15 },
        { pattern: /winner|congratulations/i, score: 0.25 },
      ];

      const spamResults = emails.map((email) => {
        let score = 0;
        const text = (email.subject ?? "") + " " + (email.bodyPreview ?? "");

        for (const indicator of spamIndicators) {
          if (indicator.pattern.test(text)) {
            score += indicator.score;
          }
        }

        return {
          id: email.id,
          spamScore: Math.min(score, 1),
        };
      });

      for (const result of spamResults) {
        await prisma.emailMessage.update({
          where: { id: result.id },
          data: {
            spamScore: result.spamScore,
            ...(result.spamScore > (config.spamThreshold ?? 0.8) ? { folder: "Spam" } : {}),
          },
        });
      }

      output = JSON.stringify({
        processed: emails.length,
        results: spamResults,
      });
    } else {
      throw new Error(`Unknown job type: ${type}`);
    }

    // Mark as completed
    if (runId) {
      await updateJobRun(runId, { status: "completed", output, completedAt: new Date() });
    }

    // Update task metadata
    await prisma.queueTask.update({
      where: { id: taskId },
      data: {
        lastRunAt: new Date(),
        runCount: { increment: 1 },
      },
    });
  } catch (err) {
    const errorMessage = (err as Error).message;

    if (runId) {
      await updateJobRun(runId, { status: "error", error: errorMessage, completedAt: new Date() });
    }

    throw err;
  }
}

// ─── Worker creation ─────────────────────────────────────────────────────────

/**
 * Create a BullMQ worker that processes all task queues.
 */
export function createWorker(concurrency = 5): Worker {
  return new Worker("saale-tasks-*", processJob, {
    connection: getConnection() as any,
    concurrency,
    limiter: {
      max: 10,
      duration: 60000,
    },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  });
}

// ─── Schedule jobs from DB ──────────────────────────────────────────────────

/**
 * Schedule all enabled jobs from the database into BullMQ.
 * Call this on server startup.
 */
export async function scheduleAllJobs(): Promise<void> {
  const tasks = await prisma.queueTask.findMany({
    where: { enabled: true },
    select: {
      id: true,
      type: true,
      config: true,
    },
  });

  for (const task of tasks) {
    const config = JSON.parse(task.config);
    const queue = getQueue(task.id);

    if (config.cronExpression) {
      try {
        await queue.add(
          "execute",
          { ...config, taskId: task.id },
          {
            jobId: task.id,
            repeat: { pattern: config.cronExpression, tz: "UTC" },
          },
        );
      } catch (err) {
        console.error(`Failed to schedule job ${task.id}: ${(err as Error).message}`);
      }
    }
  }
}
