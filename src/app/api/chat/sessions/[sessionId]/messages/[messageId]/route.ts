import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * PATCH /api/chat/sessions/:sessionId/messages/:messageId — Edit a user message.
 *
 * Creates a new branch instead of forking the session.
 * Returns { ok: true, branchId, message, streamUrl }.
 *
 * The client connects to streamUrl to get the new AI response.
 * No navigation needed — everything stays in the same session.
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

  // Create a new branch
  const newBranch = await prisma.chatBranch.create({
    data: {
      sessionId,
      divergenceMessageId: messageId,
    },
  });

  // Copy messages up to and including the edited message
  const messagesBefore = await prisma.chatMessage.findMany({
    where: {
      sessionId,
      branchId: message.branchId,
      createdAt: { lte: message.createdAt },
    },
    orderBy: { createdAt: "asc" },
    include: { attachments: true },
  });

  // Build a map of old message id -> new message id for parentMessageId rewriting
  const idMap = new Map<string, string>();

  const messageData = messagesBefore.map((m, index) => {
    const isEditedMessage = m.id === messageId;
    return {
      sessionId,
      branchId: newBranch.id,
      role: m.role,
      content: isEditedMessage ? sanitizedContent : m.content,
      thinking: m.thinking,
      toolCalls: m.toolCalls,
      parentMessageId: m.parentMessageId, // will be rewritten below
      createdAt: new Date(Date.now() + index), // preserve ordering
    };
  });

  // Bulk create messages in new branch
  if (messageData.length > 0) {
    const createdMessages = await prisma.chatMessage.createManyAndReturn({
      data: messageData,
    });

    // Build ID map for parentMessageId rewriting
    for (const [index, orig] of messagesBefore.entries()) {
      const created = createdMessages[index];
      if (orig && created) {
        idMap.set(orig.id, created.id);
      }
    }

    // Rewrite parentMessageId references to point to new branch messages
    for (const created of createdMessages) {
      if (created.parentMessageId && idMap.has(created.parentMessageId)) {
        const newParentId = idMap.get(created.parentMessageId)!;
        await prisma.chatMessage.update({
          where: { id: created.id },
          data: { parentMessageId: newParentId },
        });
      }
    }

    // Set editedAt on the edited message
    const editedMessage = createdMessages.find((_, i) => messagesBefore[i]?.id === messageId);
    if (editedMessage) {
      await prisma.chatMessage.update({
        where: { id: editedMessage.id },
        data: { editedAt: new Date() },
      });
    }

    // Copy attachments for user messages in the new branch
    for (const [index, orig] of messagesBefore.entries()) {
      if (orig && orig.attachments.length > 0) {
        const created = createdMessages[index];
        if (created) {
          for (const att of orig.attachments) {
            await prisma.chatAttachment.create({
              data: {
                messageId: created.id,
                storageId: att.storageId,
                fileName: att.fileName,
                mimeType: att.mimeType,
                size: att.size,
                width: att.width,
                height: att.height,
                storagePath: att.storagePath,
              },
            });
          }
        }
      }
    }
  }

  // Delete messages AFTER the edit point in the source branch (not the whole session)
  await prisma.chatMessage.deleteMany({
    where: {
      sessionId,
      branchId: message.branchId,
      createdAt: { gt: message.createdAt },
    },
  });

  // Update message count on session (use new branch's count)
  const newBranchMessageCount = await prisma.chatMessage.count({
    where: { sessionId, branchId: newBranch.id },
  });
  await prisma.chatSession.update({
    where: { id: sessionId },
    data: { messageCount: newBranchMessageCount },
  });

  return NextResponse.json({
    ok: true,
    branchId: newBranch.id,
    message: {
      id: idMap.get(messageId) || messageId,
      content: sanitizedContent,
      editedAt: new Date().toISOString(),
    },
    streamUrl: `/api/chat/sessions/${sessionId}/stream?branch=${newBranch.id}`,
  });
}
