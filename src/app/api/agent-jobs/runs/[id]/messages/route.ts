import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * GET /api/agent-jobs/runs/:id/messages — Get messages for a run
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  // Verify the run belongs to this user
  const run = await prisma.agentRun.findFirst({
    where: { id, userId: authResult.user.id },
    select: { id: true },
  });
  if (!run) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const messages = await prisma.agentRunMessage.findMany({
    where: { runId: id },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      role: true,
      content: true,
      thinking: true,
      toolCalls: true,
      parentMessageId: true,
      createdAt: true,
    },
  });

  return NextResponse.json({
    messages: messages.map(
      (m: {
        id: string;
        role: string;
        content: string;
        thinking: string | null;
        toolCalls: string | null;
        parentMessageId: string | null;
        createdAt: Date;
      }) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        thinking: m.thinking,
        toolCalls: m.toolCalls ? JSON.parse(m.toolCalls) : null,
        parentMessageId: m.parentMessageId,
        createdAt: m.createdAt.toISOString(),
      }),
    ),
  });
}
