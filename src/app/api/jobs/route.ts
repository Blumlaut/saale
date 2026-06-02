import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getQueue } from "@/lib/queue";

/**
 * GET /api/jobs — List user's jobs
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const jobs = await prisma.queueTask.findMany({
    where: { userId: authResult.user.id },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      type: true,
      enabled: true,
      modelId: true,
      config: true,
      lastRunAt: true,
      runCount: true,
      createdAt: true,
      updatedAt: true,
      _count: {
        select: { runs: true },
      },
    },
  });

  return NextResponse.json({
    jobs: jobs.map(
      (j: {
        id: string;
        type: string;
        enabled: boolean;
        modelId: string | null;
        config: string;
        lastRunAt: Date | null;
        runCount: number;
        createdAt: Date;
        updatedAt: Date;
        _count: { runs: number };
      }) => ({
        id: j.id,
        type: j.type,
        enabled: j.enabled,
        modelId: j.modelId,
        config: JSON.parse(j.config),
        lastRunAt: j.lastRunAt?.toISOString(),
        runCount: j.runCount,
        createdAt: j.createdAt.toISOString(),
        updatedAt: j.updatedAt.toISOString(),
        runHistoryCount: j._count.runs,
      }),
    ),
  });
}

/**
 * POST /api/jobs — Create a new job
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const { type, enabled, config, modelId } = body;

  if (!type) {
    return NextResponse.json({ error: "Job type is required" }, { status: 400 });
  }

  // Extract modelId from config if not provided at top level
  const jobConfig = config ?? {};
  const resolvedModelId = modelId ?? jobConfig.modelId ?? null;
  // Remove modelId from config (it's stored separately on the QueueTask model)
  const { modelId: _configModelId, ...cleanConfig } = jobConfig;

  const job = await prisma.queueTask.create({
    data: {
      userId: authResult.user.id,
      type,
      enabled: enabled !== false,
      modelId: resolvedModelId,
      config: JSON.stringify(cleanConfig),
    },
  });

  // Register with BullMQ if enabled
  if (job.enabled && cleanConfig.cronExpression) {
    const queue = getQueue();
    await queue
      .add(
        "execute",
        { ...cleanConfig, taskId: job.id, type: job.type, modelId: job.modelId },
        {
          jobId: `scheduled-${job.id}`,
          repeat: { pattern: cleanConfig.cronExpression, tz: "UTC" },
        },
      )
      .catch((err) => {
        console.error(`Failed to schedule job ${job.id}: ${err.message}`);
      });
  }

  return NextResponse.json({
    job: {
      id: job.id,
      type: job.type,
      enabled: job.enabled,
      modelId: job.modelId,
      config: JSON.parse(job.config),
      createdAt: job.createdAt.toISOString(),
    },
  });
}
