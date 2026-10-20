import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { serializeSharedChatMessage } from "@/lib/chat/serialize-message";

/**
 * GET /api/chat/sessions/share/:token/messages. Public endpoint for shared chats.
 *
 * No authentication required. Returns session metadata + messages.
 *
 * Every message goes through `serializeSharedChatMessage`, which redacts tool
 * calls: see `@/lib/chat/redact-tool-calls`.
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
    where: { sessionId: session.id, queuedAt: null },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      role: true,
      content: true,
      thinking: true,
      errorMessage: true,
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
    messages: messages.map(serializeSharedChatMessage),
  });
}
