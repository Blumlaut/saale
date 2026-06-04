/* eslint-disable no-console */
import "dotenv/config";
import type { Job, Processor } from "bullmq";
import { createWorker, getQueue, scheduleAllJobs } from "@/lib/queue";
import { cleanupOrphanedImages } from "@/lib/image-attachment";

/** How often to scan for orphaned image files (30 min) */
const ORPHAN_CLEANUP_INTERVAL_MS = 30 * 60 * 1000;

/** URL of the Next.js app (for job execution via API) */
const APP_URL = process.env.WORKER_APP_URL ?? "http://localhost:3000";
/** Shared secret for worker → app authentication */
const WORKER_API_KEY = process.env.WORKER_API_KEY ?? "";

async function scheduleOrphanCleanup(): Promise<void> {
  const queue = getQueue();
  await queue.add(
    "cleanup_orphaned_images",
    {},
    {
      jobId: "cleanup-orphaned-images",
      repeat: {
        pattern: `*/${Math.round(ORPHAN_CLEANUP_INTERVAL_MS / 60_000)} * * * *`,
        tz: "UTC",
      },
    },
  );
}

/**
 * Execute a user job by calling the Next.js app's internal API.
 * The app handles all Pi-dependent logic (AI dispatch, etc.).
 */
async function executeJobViaApp(job: Job): Promise<unknown> {
  const response = await fetch(`${APP_URL}/api/jobs/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-worker-key": WORKER_API_KEY,
    },
    body: JSON.stringify({
      jobId: job.id,
      name: job.name,
      data: job.data,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Job execution failed (${response.status}): ${text}`);
  }

  return response.json();
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
    return executeJobViaApp(job);
  };
}

async function main() {
  console.log("[worker] Starting BullMQ worker...");

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

  await scheduleAllJobs();
  console.log("[worker] All enabled jobs scheduled");

  await scheduleOrphanCleanup();
  console.log("[worker] Orphan cleanup scheduled (every 30min)");

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
