/* eslint-disable no-console */
import "dotenv/config";
import type { Job, Processor } from "bullmq";
import { createWorker, getQueue, scheduleAllJobs } from "@/lib/queue";
import { cleanupOrphanedImages } from "@/lib/image-attachment";

/** How often to scan for orphaned image files (30 min) */
const ORPHAN_CLEANUP_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Schedule a recurring orphan cleanup job in BullMQ.
 * Runs independently of user-scoped tasks.
 */
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
 * Wrap the user-job handler to also process system-wide jobs.
 */
function createJobRouter(userJobHandler: Processor): Processor {
  return async (job: Job) => {
    if (job.name === "cleanup_orphaned_images") {
      const deleted = await cleanupOrphanedImages();
      if (deleted > 0) {
        console.log(`[worker] Orphan cleanup: removed ${deleted} orphaned file(s)`);
      }
      return;
    }
    return userJobHandler(job);
  };
}

/**
 * Standalone BullMQ worker process.
 * Listens to all task queues and processes jobs.
 * Scheduled via `npm run worker` (runs alongside Next.js dev server).
 */
async function main() {
  console.log("[worker] Starting BullMQ worker...");

  // Lazy-load processJob to avoid importing Pi dependencies at startup
  // (tsx/Node 25 have issues resolving @earendil-works/pi-coding-agent statically)
  const { processJob } = await import("@/lib/queue/job-handler");

  const worker = createWorker(createJobRouter(processJob));

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

  // Schedule all enabled jobs from the database
  await scheduleAllJobs();
  console.log("[worker] All enabled jobs scheduled");

  // Schedule periodic orphan cleanup (system-wide, not user-scoped)
  await scheduleOrphanCleanup();
  console.log("[worker] Orphan cleanup scheduled (every 30min)");

  // Keep the process alive
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
