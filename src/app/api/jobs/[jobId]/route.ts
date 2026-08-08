import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireJobOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { syncQueueTaskSchedule, triggerQueueTaskRun, unscheduleQueueTask } from "@/lib/queue";

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

  // Sync the BullMQ repeatable job. Always resync — BullMQ does not update an
  // existing scheduler with the same jobId, so cron/model/enabled changes are
  // applied by removing first, then re-adding if the job is still scheduled.
  await syncQueueTaskSchedule({
    id: jobId,
    type: updated.type,
    enabled: updated.enabled,
    modelId: updated.modelId,
    config: updated.config,
  }).catch((err) => {
    console.error(`Failed to re-schedule job ${jobId}: ${err.message}`);
  });

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
  await unscheduleQueueTask(jobId);

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

  // Record the run and enqueue a one-off job for the worker
  const { runId } = await triggerQueueTaskRun(job);

  return NextResponse.json({
    queued: true,
    runId,
  });
}
