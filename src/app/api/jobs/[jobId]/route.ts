import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getQueue, addJobRun } from "@/lib/queue";

/**
 * PATCH /api/jobs/:jobId — Update a job
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { jobId } = await params;

  const job = await prisma.queueTask.findFirst({
    where: { id: jobId, userId: authResult.user.id },
  });

  if (!job) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json();
  const updateData: Record<string, unknown> = {};

  if (body.type !== undefined) updateData.type = body.type;
  if (body.enabled !== undefined) updateData.enabled = body.enabled;
  if (body.modelId !== undefined) updateData.modelId = body.modelId;
  if (body.config !== undefined) updateData.config = JSON.stringify(body.config);

  const updated = await prisma.queueTask.update({
    where: { id: jobId },
    data: updateData,
  });

  // Sync BullMQ schedule when enabled status changes
  if (body.enabled !== undefined) {
    const queue = getQueue();
    const jobConfig = JSON.parse(updated.config);

    if (body.enabled && jobConfig.cronExpression) {
      await queue
        .add(
          "execute",
          { ...jobConfig, taskId: jobId, type: updated.type, modelId: updated.modelId },
          {
            jobId: `scheduled-${jobId}`,
            repeat: { pattern: jobConfig.cronExpression, tz: "UTC" },
          },
        )
        .catch((err) => {
          console.error(`Failed to schedule job ${jobId}: ${err.message}`);
        });
    } else if (!body.enabled) {
      await queue
        .removeRepeatable("execute", { pattern: jobConfig.cronExpression, tz: "UTC" })
        .catch((err) => {
          console.error("Failed to remove repeatable job:", err);
        });
    }
  }

  return NextResponse.json({
    job: {
      id: updated.id,
      type: updated.type,
      enabled: updated.enabled,
      modelId: updated.modelId,
      config: JSON.parse(updated.config),
      updatedAt: updated.updatedAt.toISOString(),
    },
  });
}

/**
 * DELETE /api/jobs/:jobId — Delete a job
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { jobId } = await params;

  const job = await prisma.queueTask.findFirst({
    where: { id: jobId, userId: authResult.user.id },
  });

  if (!job) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Remove repeatable job from BullMQ
  const queue = getQueue();
  const jobConfig = JSON.parse(job.config);
  if (jobConfig.cronExpression) {
    await queue
      .removeRepeatable("execute", { pattern: jobConfig.cronExpression, tz: "UTC" })
      .catch((err) => {
        console.error("Failed to remove repeatable job on delete:", err);
      });
  }

  await prisma.queueTask.delete({
    where: { id: jobId },
  });

  return NextResponse.json({ ok: true });
}

/**
 * POST /api/jobs/:jobId — Trigger manual run
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { jobId } = await params;

  const job = await prisma.queueTask.findFirst({
    where: { id: jobId, userId: authResult.user.id },
  });

  if (!job) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const config = JSON.parse(job.config);
  const queue = getQueue();

  const jobRun = await addJobRun(jobId, "pending", JSON.stringify(config));

  await queue.add(
    "execute",
    { ...config, taskId: jobId, runId: jobRun.id, type: job.type, modelId: job.modelId },
    {
      jobId: `manual-${jobId}-${Date.now()}`,
      removeOnComplete: false,
      removeOnFail: 100,
    },
  );

  return NextResponse.json({
    queued: true,
    runId: jobRun.id,
  });
}
