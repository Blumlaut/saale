import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireJobOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * GET /api/jobs/:jobId/runs. Get run history for a job
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;

  const authResult = await requireJobOwner(jobId);
  if (!authResult.ok) return authResult.response;

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
    runs: runs.map(
      (r: {
        id: string;
        status: string;
        input: string | null;
        output: string | null;
        error: string | null;
        startedAt: Date | null;
        completedAt: Date | null;
        createdAt: Date;
      }) => ({
        id: r.id,
        status: r.status,
        input: r.input ? JSON.parse(r.input) : null,
        output: r.output ? JSON.parse(r.output) : null,
        error: r.error,
        startedAt: r.startedAt?.toISOString(),
        completedAt: r.completedAt?.toISOString(),
        duration:
          r.startedAt && r.completedAt ? r.completedAt.getTime() - r.startedAt.getTime() : null,
        createdAt: r.createdAt.toISOString(),
      }),
    ),
  });
}
