import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * GET /api/chat/sessions/:sessionId/branches — List all branches for a session
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { sessionId } = await params;

  // Verify session belongs to user
  const chatSession = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId: authResult.user.id },
    select: { id: true },
  });

  if (!chatSession) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const branches = await prisma.chatBranch.findMany({
    where: { sessionId },
    orderBy: { createdAt: "asc" },
    include: {
      _count: {
        select: { messages: true },
      },
    },
  });

  return NextResponse.json({
    branches: branches.map((b) => ({
      id: b.id,
      isMain: b.id === sessionId,
      divergenceMessageId: b.divergenceMessageId,
      messageCount: b._count.messages,
      createdAt: b.createdAt.toISOString(),
    })),
  });
}
