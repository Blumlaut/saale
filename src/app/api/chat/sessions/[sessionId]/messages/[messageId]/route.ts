import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * PATCH /api/chat/sessions/:sessionId/messages/:messageId — Edit a user message.
 *
 * Updates the message in place, deletes all messages after it,
 * and returns a stream URL for the new AI response.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string; messageId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { sessionId, messageId } = await params;

  // Verify session ownership and check if a response is already in progress
  const chatSession = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId: authResult.user.id },
    select: { id: true, processingSince: true },
  });

  if (!chatSession) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (chatSession.processingSince) {
    return NextResponse.json(
      { error: "A response is already being generated. Please wait." },
      { status: 409 },
    );
  }

  // Fetch the message
  const message = await prisma.chatMessage.findFirst({
    where: { id: messageId, sessionId },
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

  // Update the message in place, delete messages after it, and mark response in progress
  await prisma.$transaction(async (tx) => {
    // Update the message content
    await tx.chatMessage.update({
      where: { id: messageId },
      data: {
        content: sanitizedContent,
        editedAt: new Date(),
      },
    });

    // Delete all messages after this one
    await tx.chatMessage.deleteMany({
      where: {
        sessionId,
        createdAt: { gt: message.createdAt },
      },
    });

    // Mark response as in progress
    await tx.chatSession.update({
      where: { id: sessionId },
      data: { processingSince: new Date() },
    });
  });

  return NextResponse.json({
    ok: true,
    messageId,
    streamUrl: `/api/chat/sessions/${sessionId}/stream`,
  });
}
