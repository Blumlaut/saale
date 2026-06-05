import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { validateImageUpload, processAndStoreImage, deleteAllImages } from "@/lib/image-attachment";

/**
 * GET /api/chat/sessions/:sessionId/messages — Get messages for a session
 * Accepts ?branch=<branchId> to filter by branch (defaults to main branch = sessionId)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { sessionId } = await params;
  const url = new URL(request.url);
  const branchId = url.searchParams.get("branch") || sessionId;

  // Verify session belongs to user
  const chatSession = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId: authResult.user.id },
    select: {
      id: true,
      temporary: true,
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
    where: { sessionId, branchId },
    orderBy: { createdAt: "asc" },
    include: {
      attachments: true,
    },
  });

  return NextResponse.json({
    session: {
      id: chatSession.id,
      temporary: chatSession.temporary,
      modelProvider: chatSession.modelProvider,
      modelName: chatSession.modelName,
      thinkingLevel: chatSession.thinkingLevel,
      toolConfig: chatSession.toolConfig,
    },
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      thinking: m.thinking || undefined,
      toolCalls: m.toolCalls ? JSON.parse(m.toolCalls) : undefined,
      parentMessageId: m.parentMessageId || undefined,
      createdAt: m.createdAt.toISOString(),
      attachments: m.attachments.map((a) => ({
        id: a.id,
        storageId: a.storageId,
        fileName: a.fileName,
        mimeType: a.mimeType,
        size: a.size,
        width: a.width,
        height: a.height,
      })),
    })),
  });
}

/**
 * POST /api/chat/sessions/:sessionId/messages — Add a message (triggers streaming via SSE)
 *
 * Accepts either:
 * - application/json: { content: string }
 * - multipart/form-data: { content: string, files: File[] }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { sessionId } = await params;
  const url = new URL(request.url);
  const branchId = url.searchParams.get("branch") || sessionId;

  const chatSession = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId: authResult.user.id },
  });

  if (!chatSession) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    let content: string;
    const imageAttachments: Array<{
      storageId: string;
      fileName: string;
      mimeType: string;
      size: number;
      width?: number;
      height?: number;
    }> = [];

    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      // Multipart: extract text content + image files
      const formData = await request.formData();
      content = (formData.get("content") as string) || "";

      // Process image files
      const files = formData.getAll("files");
      for (const file of files) {
        if (!(file instanceof File)) continue;

        const error = validateImageUpload(file);
        if (error) {
          return NextResponse.json({ error }, { status: 400 });
        }

        const buffer = Buffer.from(await file.arrayBuffer());
        const result = await processAndStoreImage(
          authResult.user.id,
          buffer,
          file.name,
          file.type,
          file.size,
        );

        imageAttachments.push({
          storageId: result.storageId,
          fileName: file.name,
          mimeType: file.type,
          size: file.size,
          width: result.width,
          height: result.height,
        });
      }
    } else {
      // JSON: plain text message
      const body = await request.json();
      content = body.content as string;
    }

    if (typeof content !== "string") {
      return NextResponse.json({ error: "Content is required" }, { status: 400 });
    }
    if (!content.trim() && imageAttachments.length === 0) {
      return NextResponse.json({ error: "Content is required" }, { status: 400 });
    }

    // Strip null bytes and limit length
    const sanitizedContent = content.replace(/\0/g, "").slice(0, 100_000);

    // Save user message with attachments in a single transaction
    const userMessage = await prisma.chatMessage.create({
      data: {
        sessionId,
        branchId,
        role: "user",
        content: sanitizedContent,
        ...(imageAttachments.length > 0 && {
          attachments: {
            create: imageAttachments.map((att) => ({
              storageId: att.storageId,
              fileName: att.fileName,
              mimeType: att.mimeType,
              size: att.size,
              width: att.width ?? null,
              height: att.height ?? null,
              storagePath: `images/${att.storageId}.png`,
            })),
          },
        }),
      },
    });

    // Fetch the created message with attachments
    const userMessageWithAttachments = await prisma.chatMessage.findUnique({
      where: { id: userMessage.id },
      include: { attachments: true },
    });

    // Update session metadata
    await prisma.chatSession.update({
      where: { id: sessionId },
      data: {
        messageCount: { increment: 1 },
        title:
          chatSession.title === "New Chat"
            ? (sanitizedContent || "Image").slice(0, 50) +
              ((sanitizedContent || "Image").length > 50 ? "..." : "")
            : chatSession.title,
      },
    });

    // Return stream URL and the saved message for client-side replacement
    return NextResponse.json({
      ok: true,
      streamUrl: `/api/chat/sessions/${sessionId}/stream`,
      message: {
        id: userMessageWithAttachments!.id,
        role: "user" as const,
        content: userMessageWithAttachments!.content,
        createdAt: userMessageWithAttachments!.createdAt.toISOString(),
        attachments: userMessageWithAttachments!.attachments.map((a) => ({
          id: a.id,
          storageId: a.storageId,
          fileName: a.fileName,
          mimeType: a.mimeType,
          size: a.size,
          width: a.width,
          height: a.height,
        })),
      },
    });
  } catch (err) {
    console.error("POST /api/chat/sessions/:sessionId/messages error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
    );
  }
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

  // Fetch attachments for this message to clean up image files from disk
  const attachments = await prisma.chatAttachment.findMany({
    where: { messageId },
    select: { storagePath: true },
  });
  const storagePaths = attachments.map((a) => a.storagePath);

  // Delete image files from disk — throws if any deletion fails
  if (storagePaths.length > 0) {
    try {
      await deleteAllImages(authResult.user.id, storagePaths);
    } catch (err) {
      console.error(
        `Failed to delete images for message ${messageId}:`,
        err instanceof Error ? err.message : err,
      );
      return NextResponse.json(
        {
          error: "Failed to delete attached images",
          detail: err instanceof Error ? err.message : String(err),
        },
        { status: 500 },
      );
    }
  }

  await prisma.chatMessage.deleteMany({
    where: { sessionId, id: messageId },
  });

  return NextResponse.json({ ok: true });
}
