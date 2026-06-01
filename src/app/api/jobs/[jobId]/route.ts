import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { headers } from "next/headers";
import { getQueue, addJobRun } from "@/lib/queue";

/**
 * PATCH /api/jobs/:jobId — Update a job
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { jobId } = await params;

  const job = await prisma.queueTask.findFirst({
    where: { id: jobId, userId: session.user.id },
  });

  if (!job) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json();
  const updateData: Record<string, unknown> = {};

  if (body.type !== undefined) updateData.type = body.type;
  if (body.enabled !== undefined) updateData.enabled = body.enabled;
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
          { ...jobConfig, taskId: jobId, type: updated.type },
          {
            jobId: `scheduled-${jobId}`,
            repeat: { pattern: jobConfig.cronExpression, tz: "UTC" },
          },
        )
        .catch((err) => {
          console.error(`Failed to schedule job ${jobId}: ${err.message}`);
        });
    } else if (!body.enabled) {
      await queue.remove(`scheduled-${jobId}`).catch(() => {});
    }
  }

  return NextResponse.json({
    job: {
      id: updated.id,
      type: updated.type,
      enabled: updated.enabled,
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
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { jobId } = await params;

  const job = await prisma.queueTask.findFirst({
    where: { id: jobId, userId: session.user.id },
  });

  if (!job) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Remove repeatable job from BullMQ
  const queue = getQueue();
  await queue.remove(`scheduled-${jobId}`).catch(() => {});

  await prisma.queueTask.delete({
    where: { id: jobId },
  });

  return NextResponse.json({ ok: true });
}

/**
 * POST /api/jobs/:jobId/run — Trigger manual run
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { jobId } = await params;

  const job = await prisma.queueTask.findFirst({
    where: { id: jobId, userId: session.user.id },
  });

  if (!job) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const config = JSON.parse(job.config);
  const queue = getQueue();

  const jobRun = await addJobRun(jobId, "pending", JSON.stringify(config));

  await queue.add(
    "execute",
    { ...config, taskId: jobId, runId: jobRun.id, type: job.type },
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
