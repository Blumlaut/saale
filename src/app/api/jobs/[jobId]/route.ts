import { NextRequest, NextResponse } from "next/server";
import { requireJobOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getQueue, addJobRun } from "@/lib/queue";

/**
 * PATCH /api/jobs/:jobId — Update a job
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;

  const authResult = await requireJobOwner(jobId);
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const updateData: Record<string, unknown> = {};

  if (body.type !== undefined) updateData.type = body.type;
  if (body.enabled !== undefined) updateData.enabled = body.enabled;
  if (body.modelId !== undefined) {
    // Normalize "/" to ":" so modelId is always stored in canonical format
    updateData.modelId = body.modelId?.includes("/")
      ? body.modelId.replace("/", ":")
      : body.modelId;
  }
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
            repeat: { pattern: jobConfig.cronExpression, tz: "UTC", key: `scheduled-${jobId}` },
          },
        )
        .catch((err) => {
          console.error(`Failed to schedule job ${jobId}: ${err.message}`);
        });
    } else if (!body.enabled) {
      await queue.removeJobScheduler(`scheduled-${jobId}`).catch((err) => {
        console.error("Failed to remove job scheduler:", err);
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
  const { jobId } = await params;

  const authResult = await requireJobOwner(jobId);
  if (!authResult.ok) return authResult.response;

  // Remove job scheduler from BullMQ
  const queue = getQueue();
  await queue.removeJobScheduler(`scheduled-${jobId}`).catch((err) => {
    console.error("Failed to remove job scheduler on delete:", err);
  });

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
  const { jobId } = await params;

  const authResult = await requireJobOwner(jobId);
  if (!authResult.ok) return authResult.response;
  const job = authResult.job;

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
