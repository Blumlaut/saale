import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/**
 * GET /api/chat/sessions/share/:token/messages — Public endpoint for shared chats.
 *
 * No authentication required. Returns session metadata + messages.
 * Excludes attachments and thinking content for shared views.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const session = await prisma.chatSession.findFirst({
    where: { shareToken: token, shared: true },
    select: {
      id: true,
      title: true,
      createdAt: true,
    },
  });

  if (!session) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const messages = await prisma.chatMessage.findMany({
    where: { sessionId: session.id },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      role: true,
      content: true,
      toolCalls: true,
      parentMessageId: true,
      createdAt: true,
    },
  });

  return NextResponse.json({
    session: {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt.toISOString(),
    },
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls ? JSON.parse(m.toolCalls) : undefined,
      parentMessageId: m.parentMessageId || undefined,
      createdAt: m.createdAt.toISOString(),
    })),
  });
}
