import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { headers } from "next/headers";

/**
 * GET /api/jobs — List user's jobs
 */
export async function GET() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const jobs = await prisma.queueTask.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      type: true,
      enabled: true,
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
    jobs: jobs.map((j: { id: string; type: string; enabled: boolean; config: string; lastRunAt: Date | null; runCount: number; createdAt: Date; updatedAt: Date; _count: { runs: number } }) => ({
      id: j.id,
      type: j.type,
      enabled: j.enabled,
      config: JSON.parse(j.config),
      lastRunAt: j.lastRunAt?.toISOString(),
      runCount: j.runCount,
      createdAt: j.createdAt.toISOString(),
      updatedAt: j.updatedAt.toISOString(),
      runHistoryCount: j._count.runs,
    })),
  });
}

/**
 * POST /api/jobs — Create a new job
 */
export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { type, enabled, config } = body;

  if (!type) {
    return NextResponse.json(
      { error: "Job type is required" },
      { status: 400 },
    );
  }

  const job = await prisma.queueTask.create({
    data: {
      userId: session.user.id,
      type,
      enabled: enabled !== false,
      config: JSON.stringify(config ?? {}),
    },
  });

  return NextResponse.json({
    job: {
      id: job.id,
      type: job.type,
      enabled: job.enabled,
      config: JSON.parse(job.config),
      createdAt: job.createdAt.toISOString(),
    },
  });
}
