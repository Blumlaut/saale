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

// ─── QueueTask (legacy jobs) scheduling ────────────────────────────────────

/** BullMQ scheduler key for a QueueTask (legacy scheduled job). */
export function queueTaskSchedulerId(jobId: string): string {
  return `scheduled-${jobId}`;
}

/**
 * Schedule a QueueTask as a BullMQ job scheduler. the v6 replacement for
 * repeatable jobs. Only schedules when the job is enabled and its config has a
 * cronExpression.
 */
export async function scheduleQueueTask(job: {
  id: string;
  type: string;
  enabled: boolean;
  modelId: string | null;
  config: string;
}): Promise<void> {
  if (!job.enabled) return;

  const config = JSON.parse(job.config) as Record<string, unknown>;
  if (!config.cronExpression) return;

  await getQueue().upsertJobScheduler(
    queueTaskSchedulerId(job.id),
    { pattern: config.cronExpression as string, tz: "UTC" },
    { name: "execute", data: { ...config, taskId: job.id, type: job.type, modelId: job.modelId } },
  );
}

/** Remove the BullMQ repeatable scheduler for a QueueTask. */
export async function unscheduleQueueTask(jobId: string): Promise<void> {
  const schedulerId = queueTaskSchedulerId(jobId);
  await getQueue()
    .removeJobScheduler(schedulerId)
    .catch((err) => {
      console.error(`Failed to remove job scheduler ${schedulerId}:`, err);
    });
}

/**
 * (Re)sync a QueueTask's schedule with its current state.
 * Removes the existing scheduler, then re-adds one if the job is enabled and
 * its config has a cronExpression. Use after create/update: removing first is
 * what turns a disabled or cron-less job back into "not scheduled".
 */
export async function syncQueueTaskSchedule(job: {
  id: string;
  type: string;
  enabled: boolean;
  modelId: string | null;
  config: string;
}): Promise<void> {
  await unscheduleQueueTask(job.id);
  await scheduleQueueTask(job);
}

/**
 * Trigger a one-off manual run of a QueueTask: records the TaskRun and
 * enqueues a non-repeatable "execute" job. Returns the run id.
 */
export async function triggerQueueTaskRun(job: {
  id: string;
  type: string;
  modelId: string | null;
  config: string;
}): Promise<{ runId: string }> {
  const config = JSON.parse(job.config) as Record<string, unknown>;
  const run = await addJobRun(job.id, "pending", JSON.stringify(config));

  await getQueue().add(
    "execute",
    { ...config, taskId: job.id, runId: run.id, type: job.type, modelId: job.modelId },
    {
      jobId: `manual-${job.id}-${Date.now()}`,
      removeOnComplete: false,
      removeOnFail: 100,
    },
  );

  return { runId: run.id };
}

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
      enabled: true,
      modelId: true,
      config: true,
    },
  });

  for (const job of jobs) {
    try {
      await scheduleQueueTask(job);
    } catch (err) {
      console.error(`Failed to schedule job ${job.id}: ${(err as Error).message}`);
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

/** BullMQ job id for an agent definition's one-off (runAt) execution. */
export function agentOnceJobId(definitionId: string): string {
  return `agent-once-${definitionId}`;
}

/** The scheduling-relevant fields of an AgentDefinition. */
export interface AgentSchedule {
  id: string;
  enabled: boolean;
  cronExpression: string | null;
  runAt: Date | null;
}

/**
 * Schedule a single agent definition.
 *
 * A one-off `runAt` takes precedence over the recurring cron expression: the
 * run is enqueued as a delayed BullMQ job that fires once. Re-adding with the
 * same jobId is a no-op while it is still queued, so a restart does not
 * duplicate it; a past `runAt` fires immediately (catch-up after downtime).
 *
 * @param definition - The definition's id, enabled flag, and schedule fields
 */
export async function scheduleAgentDefinition(definition: AgentSchedule): Promise<void> {
  if (!definition.enabled) return;

  if (definition.runAt) {
    const delay = Math.max(0, definition.runAt.getTime() - Date.now());
    await getQueue().add(
      "agent_execute",
      { definitionId: definition.id },
      {
        jobId: agentOnceJobId(definition.id),
        delay,
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
    return;
  }

  if (!definition.cronExpression) return;

  await getQueue().upsertJobScheduler(
    agentSchedulerId(definition.id),
    { pattern: definition.cronExpression, tz: "UTC" },
    { name: "agent_execute", data: { definitionId: definition.id } },
  );
}

/** Remove both the recurring scheduler and any pending one-off job. */
export async function unscheduleAgentDefinition(definitionId: string): Promise<void> {
  const schedulerId = agentSchedulerId(definitionId);
  await getQueue()
    .removeJobScheduler(schedulerId)
    .catch((err) => {
      console.error(`Failed to remove agent definition scheduler ${schedulerId}:`, err);
    });

  const jobId = agentOnceJobId(definitionId);
  await getQueue()
    .remove(jobId)
    .catch((err) => {
      console.error(`Failed to remove agent one-off job ${jobId}:`, err);
    });
}

/**
 * (Re)sync an agent definition's schedule with its current state.
 * Removes any existing scheduler/job, then re-adds one if the definition is
 * enabled and has a one-off run time or a cron expression. Use after
 * create/update.
 */
export async function syncAgentDefinitionSchedule(definition: AgentSchedule): Promise<void> {
  await unscheduleAgentDefinition(definition.id);
  await scheduleAgentDefinition(definition);
}

/**
 * Schedule all agent definitions with a schedule into BullMQ.
 * Call on worker startup. Also removes stale schedulers for definitions
 * that are disabled or no longer have a schedule.
 */
export async function scheduleAllAgentDefinitions(): Promise<void> {
  const definitions = await prisma.agentDefinition.findMany({
    select: { id: true, enabled: true, cronExpression: true, runAt: true },
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

// ─── Script watcher scheduling ──────────────────────────────────────────────

/** BullMQ scheduler key namespace for script watchers. */
const WATCHER_SCHEDULER_PREFIX = "watcher-scheduled-";

/** Job name the watcher schedulers enqueue. */
export const WATCHER_TICK_JOB_NAME = "watcher_tick";

/** Scheduler id for a watcher. */
export function watcherSchedulerId(watcherId: string): string {
  return `${WATCHER_SCHEDULER_PREFIX}${watcherId}`;
}

/** The scheduling-relevant fields of a ScriptWatcher. */
export interface WatcherSchedule {
  id: string;
  enabled: boolean;
  cronExpression: string;
}

/**
 * Schedule a watcher's ticks.
 *
 * Cron granularity is one minute, which is also the fastest a watcher can poll
 * the tick itself is a sandbox run, not a model call, but there is no point
 * polling faster than the queue can schedule.
 */
export async function scheduleWatcher(watcher: WatcherSchedule): Promise<void> {
  if (!watcher.enabled || !watcher.cronExpression) return;

  await getQueue().upsertJobScheduler(
    watcherSchedulerId(watcher.id),
    { pattern: watcher.cronExpression, tz: "UTC" },
    { name: WATCHER_TICK_JOB_NAME, data: { watcherId: watcher.id } },
  );
}

/** Remove a watcher's tick scheduler. */
export async function unscheduleWatcher(watcherId: string): Promise<void> {
  const schedulerId = watcherSchedulerId(watcherId);
  await getQueue()
    .removeJobScheduler(schedulerId)
    .catch((err) => {
      console.error(`Failed to remove watcher scheduler ${schedulerId}:`, err);
    });
}

/**
 * (Re)sync a watcher's schedule with its current state. Use after
 * create/update. a changed cron needs the old scheduler gone first, or both
 * patterns would fire.
 */
export async function syncWatcherSchedule(watcher: WatcherSchedule): Promise<void> {
  await unscheduleWatcher(watcher.id);
  await scheduleWatcher(watcher);
}

/**
 * Schedule every enabled watcher. Call on worker startup. Disabled watchers are
 * unscheduled rather than skipped, so a watcher switched off while the worker
 * was down does not resume ticking on boot.
 */
export async function scheduleAllWatchers(): Promise<void> {
  const watchers = await prisma.scriptWatcher.findMany({
    select: { id: true, enabled: true, cronExpression: true },
  });

  for (const watcher of watchers) {
    try {
      await syncWatcherSchedule(watcher);
    } catch (err) {
      console.error(`Failed to schedule watcher ${watcher.id}:`, (err as Error).message);
    }
  }
}

// ─── Orphaned image cleanup ─────────────────────────────────────────────────

/** Job scheduler id of the orphaned-image cleanup. */
export const ORPHAN_CLEANUP_SCHEDULER_ID = "cleanup-orphaned-images";

/** Job name the orphaned-image cleanup scheduler enqueues. */
export const ORPHAN_CLEANUP_JOB_NAME = "cleanup_orphaned_images";

/**
 * Register the orphaned-image cleanup job scheduler.
 *
 * @param intervalMinutes - How often to scan for orphaned image files
 * @returns Scheduler ids removed while cleaning up legacy repeatable jobs
 */
export async function scheduleOrphanCleanup(intervalMinutes: number): Promise<string[]> {
  const queue = getQueue();
  const removed = await removeLegacyRepeatableJobs(
    queue,
    ORPHAN_CLEANUP_JOB_NAME,
    ORPHAN_CLEANUP_SCHEDULER_ID,
  );

  await queue.upsertJobScheduler(
    ORPHAN_CLEANUP_SCHEDULER_ID,
    { pattern: `*/${intervalMinutes} * * * *`, tz: "UTC" },
    { name: ORPHAN_CLEANUP_JOB_NAME, data: {} },
  );

  return removed;
}

// ─── Council runs ───────────────────────────────────────────────────────────

export const COUNCIL_SWEEP_SCHEDULER_ID = "council-run-sweep";
export const COUNCIL_SWEEP_JOB_NAME = "council_sweep";

/**
 * Register the sweep that rescues council runs left `running` by a dead process.
 *
 * A council run's loop lives in the web process and holds the council's run
 * slot through the row's `status`; a restart mid-run would leave that row behind
 * and refuse every later run. The sweep is what releases it, and it is the only
 * thing council scheduling needs from the queue.
 *
 * @param intervalMinutes - How often to look for abandoned runs
 * @returns Scheduler ids removed while cleaning up legacy repeatable jobs
 */
export async function scheduleCouncilSweep(intervalMinutes: number): Promise<string[]> {
  const queue = getQueue();
  const removed = await removeLegacyRepeatableJobs(
    queue,
    COUNCIL_SWEEP_JOB_NAME,
    COUNCIL_SWEEP_SCHEDULER_ID,
  );

  await queue.upsertJobScheduler(
    COUNCIL_SWEEP_SCHEDULER_ID,
    { pattern: `*/${intervalMinutes} * * * *`, tz: "UTC" },
    { name: COUNCIL_SWEEP_JOB_NAME, data: {} },
  );

  return removed;
}

/**
 * Remove BullMQ v5 repeatable jobs that v6 treats as job schedulers of their own.
 *
 * v5 stored repeatable jobs in the same ZSET that v6 reads as job schedulers.
 * Entries created with an explicit `repeat.key` keep working. the key is the
 * scheduler id, so `removeJobScheduler` still finds it. but a keyless one got
 * an md5 key that v6 adopts as a separate scheduler, firing alongside the
 * scheduler that replaced it. Filtering by job name and keeping the current
 * scheduler id makes this idempotent.
 *
 * @returns The scheduler ids that were removed
 */
async function removeLegacyRepeatableJobs(
  queue: Queue,
  jobName: string,
  keepSchedulerId: string,
): Promise<string[]> {
  let schedulers;
  try {
    schedulers = await queue.getJobSchedulers();
  } catch (err) {
    console.error(`Failed to list BullMQ job schedulers while pruning ${jobName}:`, err);
    return [];
  }

  const removed: string[] = [];
  for (const scheduler of schedulers) {
    if (scheduler.name !== jobName) continue;

    // The repeat-set member is the scheduler id: `getJobSchedulers()` reports it
    // as `key` (bullmq 6 leaves `id` unset) and that is what removal takes.
    const schedulerId = scheduler.key;
    if (schedulerId === keepSchedulerId) continue;

    try {
      await queue.removeJobScheduler(schedulerId);
      removed.push(schedulerId);
    } catch (err) {
      console.error(`Failed to remove legacy BullMQ repeatable job ${schedulerId}:`, err);
    }
  }

  return removed;
}
