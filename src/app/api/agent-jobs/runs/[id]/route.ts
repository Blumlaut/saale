import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * GET /api/agent-jobs/runs/:id. Get run details
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const run = await prisma.agentRun.findFirst({
    where: { id, userId: authResult.user.id },
    include: {
      definition: {
        select: {
          id: true,
          name: true,
          description: true,
        },
      },
    },
  });

  if (!run) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    run: {
      id: run.id,
      definitionId: run.definitionId,
      definition: run.definition,
      status: run.status,
      prompt: run.prompt,
      systemPrompt: run.systemPrompt,
      modelId: run.modelId,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      cost: run.cost,
      error: run.error,
      deliveryError: run.deliveryError,
      startedAt: run.startedAt?.toISOString(),
      completedAt: run.completedAt?.toISOString(),
      duration:
        run.startedAt && run.completedAt
          ? run.completedAt.getTime() - run.startedAt.getTime()
          : null,
      createdAt: run.createdAt.toISOString(),
    },
  });
}
