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

// ─── Agent definition scheduling ────────────────────────────────────────────

/** BullMQ scheduler key namespace for agent definitions (separate from QueueTask). */
const AGENT_SCHEDULER_PREFIX = "agent-scheduled-";

/** Scheduler id (jobId + repeat key) for an agent definition. */
export function agentSchedulerId(definitionId: string): string {
  return `${AGENT_SCHEDULER_PREFIX}${definitionId}`;
}

/**
 * Schedule a single agent definition as a repeatable BullMQ job.
 * Only schedules when the definition is enabled and has a cron expression.
 *
 * @param definition - The definition's id, enabled flag, and cron expression
 */
export async function scheduleAgentDefinition(definition: {
  id: string;
  enabled: boolean;
  cronExpression: string | null;
}): Promise<void> {
  if (!definition.enabled || !definition.cronExpression) return;

  const queue = getQueue();
  const schedulerId = agentSchedulerId(definition.id);
  await queue.add(
    "agent_execute",
    { definitionId: definition.id },
    {
      jobId: schedulerId,
      repeat: {
        pattern: definition.cronExpression,
        tz: "UTC",
        key: schedulerId,
      },
    },
  );
}

/** Remove the BullMQ repeatable scheduler for an agent definition. */
export async function unscheduleAgentDefinition(definitionId: string): Promise<void> {
  const schedulerId = agentSchedulerId(definitionId);
  await getQueue()
    .removeJobScheduler(schedulerId)
    .catch((err) => {
      console.error(`Failed to remove agent definition scheduler ${schedulerId}:`, err);
    });
}

/**
 * (Re)sync an agent definition's schedule with its current state.
 * Removes any existing scheduler, then re-adds one if the definition is
 * enabled and has a cron expression. Use after create/update.
 */
export async function syncAgentDefinitionSchedule(definition: {
  id: string;
  enabled: boolean;
  cronExpression: string | null;
}): Promise<void> {
  await unscheduleAgentDefinition(definition.id);
  await scheduleAgentDefinition(definition);
}

/**
 * Schedule all agent definitions with cron expressions into BullMQ.
 * Call on worker startup. Also removes stale schedulers for definitions
 * that are disabled or no longer have a cron expression.
 */
export async function scheduleAllAgentDefinitions(): Promise<void> {
  const definitions = await prisma.agentDefinition.findMany({
    select: { id: true, enabled: true, cronExpression: true },
  });

  for (const definition of definitions) {
    try {
      await syncAgentDefinitionSchedule(definition);
    } catch (err) {
      console.error(
        `Failed to schedule agent definition ${definition.id}:`,
        (err as Error).message,
      );
    }
  }
}
