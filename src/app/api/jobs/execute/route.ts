import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type { Job } from "bullmq";
import { processJob } from "@/lib/queue/job-handler";

/** Shared secret for worker → app authentication */
const WORKER_API_KEY = process.env.WORKER_API_KEY ?? "";

/**
 * POST /api/jobs/execute
 * Internal endpoint called by the BullMQ worker to execute user jobs.
 * Authenticated via x-worker-key header.
 */
export async function POST(request: NextRequest) {
  const key = request.headers.get("x-worker-key");

  if (key !== WORKER_API_KEY || !WORKER_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { jobId, data } = body as {
    jobId: number | string;
    data: Record<string, unknown>;
  };

  try {
    // Minimal job stub. processJob only accesses job.data
    const mockJob = {
      id: typeof jobId === "number" ? jobId : Number(jobId),
      name: "execute",
      data,
    } as unknown as Job;

    await processJob(mockJob);

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[api/jobs/execute] Job ${jobId} failed:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
