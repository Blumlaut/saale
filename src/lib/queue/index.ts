import { Queue, Worker, type Processor } from "bullmq";
import { prisma } from "@/lib/db";

// ─── Connection ──────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/**
 * Get a BullMQ connection (uses Redis URL string to avoid ioredis version conflicts).
 */
export function getConnection(): string {
  return REDIS_URL;
}

// ─── Shared Queue ────────────────────────────────────────────────────────────

const QUEUE_NAME = "saale-jobs";
let _queue: Queue | null = null;

/**
 * Get the shared BullMQ queue (singleton to avoid connection leaks).
 * All jobs share one queue; entries are differentiated by taskId in job data.
 */
export function getQueue(): Queue {
  if (!_queue) {
    _queue = new Queue(QUEUE_NAME, {
      connection: { url: getConnection() },
    });
  }
  return _queue;
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

// ─── Worker creation ─────────────────────────────────────────────────────────

/**
 * Create a BullMQ worker for the shared job queue.
 * @param processHandler - Job processing function (lazy-loaded to avoid Pi imports at startup)
 * @param concurrency - Number of concurrent jobs
 */
export function createWorker(processHandler: Processor, concurrency = 5): Worker {
  return new Worker(QUEUE_NAME, processHandler, {
    connection: { url: getConnection() },
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
  const jobs = await prisma.queueTask.findMany({
    where: { enabled: true },
    select: {
      id: true,
      type: true,
      modelId: true,
      config: true,
    },
  });

  const queue = getQueue();
  for (const job of jobs) {
    const config = JSON.parse(job.config);

    if (config.cronExpression) {
      try {
        await queue.add(
          "execute",
          { ...config, taskId: job.id, type: job.type, modelId: job.modelId },
          {
            jobId: `scheduled-${job.id}`,
            repeat: { pattern: config.cronExpression, tz: "UTC", key: `scheduled-${job.id}` },
          },
        );
      } catch (err) {
        console.error(`Failed to schedule job ${job.id}: ${(err as Error).message}`);
      }
    }
  }
}
