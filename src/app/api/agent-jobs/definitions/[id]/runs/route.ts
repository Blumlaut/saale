import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { triggerAgentRun } from "@/lib/agent-jobs/run";
import { SYSTEM_MANAGED_ERROR } from "@/lib/agent-jobs/system-managed";

/**
 * GET /api/agent-jobs/definitions/:id/runs. List runs for a definition
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  // Verify the definition belongs to this user
  const definition = await prisma.agentDefinition.findFirst({
    where: { id, userId: authResult.user.id },
    select: { id: true },
  });
  if (!definition) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20", 10), 100);
  const status = url.searchParams.get("status") ?? undefined;

  const where: Record<string, unknown> = { definitionId: id, userId: authResult.user.id };
  if (status) {
    where.status = status;
  }

  const runs = await prisma.agentRun.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      status: true,
      prompt: true,
      modelId: true,
      inputTokens: true,
      outputTokens: true,
      cost: true,
      error: true,
      deliveryError: true,
      startedAt: true,
      completedAt: true,
      outputChannel: true,
      outputChannelId: true,
      createdAt: true,
      _count: { select: { messages: true } },
    },
  });

  return NextResponse.json({
    runs: runs.map(
      (r: {
        id: string;
        status: string;
        prompt: string;
        modelId: string | null;
        inputTokens: number;
        outputTokens: number;
        cost: number;
        error: string | null;
        deliveryError: string | null;
        startedAt: Date | null;
        completedAt: Date | null;
        outputChannel: string | null;
        outputChannelId: string | null;
        createdAt: Date;
        _count: { messages: number };
      }) => ({
        id: r.id,
        status: r.status,
        prompt: r.prompt,
        modelId: r.modelId,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cost: r.cost,
        error: r.error,
        deliveryError: r.deliveryError,
        outputChannel: r.outputChannel,
        outputChannelId: r.outputChannelId,
        startedAt: r.startedAt?.toISOString(),
        completedAt: r.completedAt?.toISOString(),
        messageCount: r._count.messages,
        duration:
          r.startedAt && r.completedAt ? r.completedAt.getTime() - r.startedAt.getTime() : null,
        createdAt: r.createdAt.toISOString(),
      }),
    ),
  });
}

/**
 * POST /api/agent-jobs/definitions/:id/runs. Trigger a new run
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  // Verify the definition belongs to this user
  const definition = await prisma.agentDefinition.findFirst({
    where: { id, userId: authResult.user.id },
    select: { id: true, enabled: true, systemManaged: true },
  });
  if (!definition) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (definition.systemManaged) {
    return NextResponse.json({ error: SYSTEM_MANAGED_ERROR }, { status: 403 });
  }

  if (!definition.enabled) {
    return NextResponse.json({ error: "Definition is disabled" }, { status: 400 });
  }

  // Parse optional prompt override from request body
  let body: Record<string, unknown> | undefined;
  try {
    body = await request.json();
  } catch {
    // No body. use definition's prompt
  }
  const promptOverride = (body?.prompt as string) || undefined;

  // Create the run record and dispatch execution (fire-and-forget)
  const run = await triggerAgentRun({
    definitionId: id,
    userId: authResult.user.id,
    ...(promptOverride ? { promptOverride } : {}),
  });

  return NextResponse.json({
    run: {
      id: run.id,
      status: run.status,
      outputChannel: run.outputChannel,
      outputChannelId: run.outputChannelId,
      createdAt: run.createdAt.toISOString(),
    },
  });
}
