/* eslint-disable no-console */
import "dotenv/config";
import type { Job, Processor } from "bullmq";
import {
  CODER_SWEEP_JOB_NAME,
  scheduleCoderSweep,
  COUNCIL_SWEEP_JOB_NAME,
  createWorker,
  scheduleAllAgentDefinitions,
  scheduleAllJobs,
  scheduleAllWatchers,
  scheduleCouncilSweep,
  scheduleOrphanCleanup,
  WATCHER_TICK_JOB_NAME,
} from "@/lib/queue";
import { isCouncilEnabled } from "@/lib/council/flag";
import { cleanupOrphanedImages } from "@/lib/image-attachment";
import { registerTelegramWebhook } from "@/lib/telegram";

/** How often to scan for orphaned image files (30 min) */
const ORPHAN_CLEANUP_INTERVAL_MINUTES = 30;

/** How often to look for council runs abandoned by a restarted app (2 min) */
const COUNCIL_SWEEP_INTERVAL_MINUTES = 2;

/** How often to reconcile coder worktree rows with their checkouts (daily) */
const CODER_SWEEP_INTERVAL_MINUTES = 24 * 60;

/** URL of the Next.js app (for job execution via API) */
const APP_URL = process.env.WORKER_APP_URL ?? "http://localhost:3000";
/** Shared secret for worker → app authentication */
const WORKER_API_KEY = process.env.WORKER_API_KEY ?? "";

/** Register the coder worktree sweep, reporting pruned v5 repeatable jobs. */
async function registerCoderSweep(): Promise<void> {
  const removed = await scheduleCoderSweep(CODER_SWEEP_INTERVAL_MINUTES);
  for (const id of removed) {
    console.log(`[worker] Removed legacy repeatable job ${id}`);
  }
}

/** Register the orphan cleanup scheduler, reporting pruned v5 repeatable jobs. */
async function registerOrphanCleanup(): Promise<void> {
  const removed = await scheduleOrphanCleanup(ORPHAN_CLEANUP_INTERVAL_MINUTES);
  for (const id of removed) {
    console.log(`[worker] Removed legacy repeatable job ${id}`);
  }
}

/**
 * Call the Next.js app's internal API from the worker.
 * The app handles all Pi-dependent logic (AI dispatch, run records, etc.).
 */
async function postToApp(path: string, payload: unknown): Promise<unknown> {
  const response = await fetch(`${APP_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-worker-key": WORKER_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`App call ${path} failed (${response.status}): ${text}`);
  }

  return response.json();
}

/**
 * Execute a user job by calling the Next.js app's internal API.
 */
async function executeJobViaApp(job: Job): Promise<unknown> {
  return postToApp("/api/jobs/execute", {
    jobId: job.id,
    name: job.name,
    data: job.data,
  });
}

/**
 * Execute a scheduled agent definition run by calling the Next.js app's
 * internal API (the app creates the AgentRun and dispatches the agent).
 */
async function executeAgentJobViaApp(job: Job): Promise<unknown> {
  return postToApp("/api/agent-jobs/execute", {
    definitionId: (job.data as { definitionId?: string }).definitionId,
  });
}

/**
 * Execute one watcher tick by calling the Next.js app's internal API.
 *
 * The tick needs the app's tool factories and the user's settings, and the app
 * is where the sandbox already runs for chats. the worker only schedules.
 */
async function executeWatcherTickViaApp(job: Job): Promise<unknown> {
  return postToApp("/api/watchers/execute", {
    watcherId: (job.data as { watcherId?: string }).watcherId,
  });
}

/**
 * Rescue council runs whose loop died with a restarted app.
 *
 * The app owns the council tables (and the run records), so the sweep is an app
 * call like the watcher tick rather than an inline worker job.
 */
async function executeCouncilSweepViaApp(): Promise<unknown> {
  return postToApp("/api/council/execute", {});
}

/** Reconcile coder worktree rows with their checkouts. */
async function executeCoderSweepViaApp(): Promise<unknown> {
  return postToApp("/api/coder/sweep", {});
}

/** Route jobs: system jobs inline, user jobs via Next.js API. */
function createJobRouter(): Processor {
  return async (job: Job) => {
    if (job.name === "cleanup_orphaned_images") {
      const deleted = await cleanupOrphanedImages();
      if (deleted > 0) {
        console.log(`[worker] Orphan cleanup: removed ${deleted} orphaned file(s)`);
      }
      return;
    }
    if (job.name === "agent_execute") {
      return executeAgentJobViaApp(job);
    }
    if (job.name === WATCHER_TICK_JOB_NAME) {
      return executeWatcherTickViaApp(job);
    }
    if (job.name === COUNCIL_SWEEP_JOB_NAME) {
      return executeCouncilSweepViaApp();
    }
    if (job.name === CODER_SWEEP_JOB_NAME) {
      return executeCoderSweepViaApp();
    }
    return executeJobViaApp(job);
  };
}

/** Retry a function with exponential backoff until it succeeds. */
async function retryUntilSuccess(
  label: string,
  fn: () => Promise<void>,
  { maxDelay = 30_000, initialDelay = 3_000 }: { maxDelay?: number; initialDelay?: number } = {},
): Promise<void> {
  let delay = initialDelay;
  while (true) {
    try {
      await fn();
      console.log(`[worker] ${label}. ok`);
      return;
    } catch (err) {
      console.error(
        `[worker] ${label} failed (${(err as Error).message}), retrying in ${delay / 1000}s...`,
      );
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, maxDelay);
    }
  }
}

async function main() {
  console.log("[worker] Starting BullMQ worker...");
  console.log("");
  console.log("[worker] DATABASE_URL:", process.env.DATABASE_URL ? "set" : "missing");
  console.log("[worker] REDIS_URL:", process.env.REDIS_URL ?? "redis://localhost:6379");
  console.log("[worker] WORKER_APP_URL:", APP_URL);
  console.log("");

  const worker = createWorker(createJobRouter());

  worker.on("error", (err) => {
    console.error("[worker] Worker error:", err.message);
  });

  worker.on("failed", (job, err) => {
    console.error(`[worker] Job ${job?.id} failed:`, err.message);
  });

  worker.on("completed", (job) => {
    console.log(`[worker] Job ${job?.id} completed`);
  });

  console.log("[worker] Worker started, listening for jobs...");

  await retryUntilSuccess("Schedule all jobs", scheduleAllJobs);
  await retryUntilSuccess("Schedule agent definitions", scheduleAllAgentDefinitions);
  await retryUntilSuccess("Schedule watchers", scheduleAllWatchers);
  if (isCouncilEnabled()) {
    await retryUntilSuccess("Schedule council sweep", async () => {
      await scheduleCouncilSweep(COUNCIL_SWEEP_INTERVAL_MINUTES);
    });
  }
  await retryUntilSuccess("Schedule orphan cleanup", registerOrphanCleanup);
  await retryUntilSuccess("Schedule coder worktree sweep", registerCoderSweep);
  await retryUntilSuccess("Register Telegram webhook", registerTelegramWebhook);

  process.on("SIGINT", async () => {
    console.log("[worker] Shutting down...");
    await worker.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    console.log("[worker] Shutting down...");
    await worker.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[worker] Failed to start:", err);
  process.exit(1);
});
