import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { headers } from "next/headers";

/**
 * GET /api/jobs/:jobId/runs — Get run history for a job
 */
export async function GET(
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

  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
  const status = url.searchParams.get("status");

  const where: Record<string, unknown> = { taskId: jobId };
  if (status) {
    where.status = status;
  }

  const runs = await prisma.taskRun.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      status: true,
      input: true,
      output: true,
      error: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
    },
  });

  return NextResponse.json({
    runs: runs.map((r: { id: string; status: string; input: string | null; output: string | null; error: string | null; startedAt: Date | null; completedAt: Date | null; createdAt: Date }) => ({
      id: r.id,
      status: r.status,
      input: r.input ? JSON.parse(r.input) : null,
      output: r.output ? JSON.parse(r.output) : null,
      error: r.error,
      startedAt: r.startedAt?.toISOString(),
      completedAt: r.completedAt?.toISOString(),
      duration:
        r.startedAt && r.completedAt
          ? r.completedAt.getTime() - r.startedAt.getTime()
          : null,
      createdAt: r.createdAt.toISOString(),
    })),
  });
}
