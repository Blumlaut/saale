import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * PATCH /api/chat/sessions/:sessionId/messages/:messageId — Edit a user message.
 *
 * Behavior:
 * - If no assistant messages exist after the edited message: update in-place.
 *   Returns { ok: true, message, streamUrl } — caller should connect to streamUrl for new AI response.
 * - If assistant messages exist after: fork the session.
 *   Returns { ok: true, forkedSessionId, message, streamUrl }.
 *
 * In both cases, messages after the edit point (assistant responses) are removed
 * so the AI generates a fresh response to the edited message.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string; messageId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { sessionId, messageId } = await params;

  // Verify session ownership
  const chatSession = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId: authResult.user.id },
  });

  if (!chatSession) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Fetch the message
  const message = await prisma.chatMessage.findFirst({
    where: { id: messageId, sessionId },
    include: { attachments: true },
  });

  if (!message) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }
  if (message.role !== "user") {
    return NextResponse.json({ error: "Only user messages can be edited" }, { status: 400 });
  }

  const body = await request.json();
  const { content } = body;

  if (typeof content !== "string" || !content.trim()) {
    return NextResponse.json({ error: "Content is required" }, { status: 400 });
  }

  // Sanitize content
  const sanitizedContent = content.replace(/\0/g, "").slice(0, 100_000);

  // Check if there are assistant messages after this one
  const messagesAfter = await prisma.chatMessage.findMany({
    where: {
      sessionId,
      createdAt: { gt: message.createdAt },
      role: { in: ["assistant", "toolResult"] },
    },
    orderBy: { createdAt: "asc" },
  });

  if (messagesAfter.length > 0) {
    // FORK: Create a new session
    const forkedSession = await prisma.chatSession.create({
      data: {
        userId: authResult.user.id,
        title: chatSession.title,
        temporary: chatSession.temporary,
        modelProvider: chatSession.modelProvider,
        modelName: chatSession.modelName,
        thinkingLevel: chatSession.thinkingLevel,
        ...(chatSession.toolConfig && { toolConfig: chatSession.toolConfig }),
        forkedFromSessionId: sessionId,
        forkedAtMessageId: messageId,
      },
    });

    // Copy messages up to (but not including) the edited message
    const messagesBefore = await prisma.chatMessage.findMany({
      where: {
        sessionId,
        createdAt: { lt: message.createdAt },
      },
      orderBy: { createdAt: "asc" },
    });

    const messageData = messagesBefore.map((m) => ({
      sessionId: forkedSession.id,
      role: m.role,
      content: m.content,
      thinking: m.thinking,
      toolCalls: m.toolCalls,
      parentMessageId: m.parentMessageId,
    }));

    // Add the edited message (editedAt set via raw SQL after bulk insert)
    messageData.push({
      sessionId: forkedSession.id,
      role: "user",
      content: sanitizedContent,
      thinking: null,
      toolCalls: null,
      parentMessageId: null,
    });

    // Bulk create messages in forked session
    if (messageData.length > 0) {
      await prisma.chatMessage.createMany({
        data: messageData,
      });

      // Set editedAt on the last (edited) message via raw SQL
      // (editedAt field added by migration, Prisma client may not have it yet)
      await prisma.$executeRaw`UPDATE "ChatMessage" SET "editedAt" = NOW() WHERE "sessionId" = ${forkedSession.id} AND "role" = 'user' AND "editedAt" IS NULL`;
    }

    // Update message count
    await prisma.chatSession.update({
      where: { id: forkedSession.id },
      data: { messageCount: messageData.length },
    });

    // Delete assistant messages after the edit point in the original session
    if (messagesAfter.length > 0) {
      await prisma.chatMessage.deleteMany({
        where: {
          sessionId,
          createdAt: { gt: message.createdAt },
        },
      });
    }

    return NextResponse.json({
      ok: true,
      forkedSessionId: forkedSession.id,
      message: {
        id: messageId,
        content: sanitizedContent,
        editedAt: new Date().toISOString(),
      },
      streamUrl: `/api/chat/sessions/${forkedSession.id}/stream`,
    });
  }

  // IN-PLACE UPDATE: No messages after, just update
  await prisma.chatMessage.update({
    where: { id: messageId },
    data: {
      content: sanitizedContent,
      editedAt: new Date(),
    },
  });

  // Also delete any assistant messages that might exist (safety net)
  await prisma.chatMessage.deleteMany({
    where: {
      sessionId,
      createdAt: { gt: message.createdAt },
    },
  });

  return NextResponse.json({
    ok: true,
    message: {
      id: messageId,
      content: sanitizedContent,
      editedAt: new Date().toISOString(),
    },
    streamUrl: `/api/chat/sessions/${sessionId}/stream`,
  });
}
