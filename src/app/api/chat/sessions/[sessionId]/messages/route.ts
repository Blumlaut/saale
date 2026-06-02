import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * GET /api/chat/sessions/:sessionId/messages — Get messages for a session
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
    select: {
      id: true,
      modelProvider: true,
      modelName: true,
      thinkingLevel: true,
      toolConfig: true,
    },
  });

  if (!chatSession) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const messages = await prisma.chatMessage.findMany({
    where: { sessionId },
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
    session: {
      id: chatSession.id,
      modelProvider: chatSession.modelProvider,
      modelName: chatSession.modelName,
      thinkingLevel: chatSession.thinkingLevel,
      toolConfig: chatSession.toolConfig,
    },
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
        thinking: m.thinking || undefined,
        toolCalls: m.toolCalls ? JSON.parse(m.toolCalls) : undefined,
        parentMessageId: m.parentMessageId || undefined,
        createdAt: m.createdAt.toISOString(),
      }),
    ),
  });
}

/**
 * POST /api/chat/sessions/:sessionId/messages — Add a message (triggers streaming via SSE)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { sessionId } = await params;

  const chatSession = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId: authResult.user.id },
  });

  if (!chatSession) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json();
  const { content } = body;

  if (!content || typeof content !== "string") {
    return NextResponse.json({ error: "Content is required" }, { status: 400 });
  }

  // Save user message
  const userMessage = await prisma.chatMessage.create({
    data: {
      sessionId,
      role: "user",
      content,
    },
  });

  // Update session metadata
  await prisma.chatSession.update({
    where: { id: sessionId },
    data: {
      messageCount: { increment: 1 },
      title:
        chatSession.title === "New Chat"
          ? content.slice(0, 50) + (content.length > 50 ? "..." : "")
          : chatSession.title,
    },
  });

  // Return stream URL and the saved message for client-side replacement
  return NextResponse.json({
    ok: true,
    streamUrl: `/api/chat/sessions/${sessionId}/stream`,
    message: {
      id: userMessage.id,
      role: "user" as const,
      content: userMessage.content,
      createdAt: userMessage.createdAt.toISOString(),
    },
  });
}

/**
 * DELETE /api/chat/sessions/:sessionId/messages — Delete a message
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { sessionId } = await params;
  const url = new URL(request.url);
  const messageId = url.searchParams.get("id");

  if (!messageId) {
    return NextResponse.json({ error: "Message ID is required" }, { status: 400 });
  }

  const chatSession = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId: authResult.user.id },
  });

  if (!chatSession) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.chatMessage.deleteMany({
    where: { sessionId, id: messageId },
  });

  return NextResponse.json({ ok: true });
}
