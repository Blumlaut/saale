import { createWorker, scheduleAllJobs } from "@/lib/queue";

/**
 * Standalone BullMQ worker process.
 * Listens to all task queues and processes jobs.
 * Scheduled via `npm run worker` (runs alongside Next.js dev server).
 */
async function main() {
  console.log("[worker] Starting BullMQ worker...");

  const worker = createWorker();

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
