import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireChatSessionOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { isSessionActive, registerActiveSession, setPendingPrompt } from "@/lib/redis";
import { deleteAllImages } from "@/lib/image-attachment";
import {
  buildAttachmentPromptText,
  deliverChatFileToAgent,
  storeChatFile,
  validateChatFile,
  type StoredChatFile,
} from "@/lib/file-attachment";

/**
 * GET /api/chat/sessions/:sessionId/messages — Get messages for a session
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  const authResult = await requireChatSessionOwner(sessionId);
  if (!authResult.ok) return authResult.response;
  const chatSession = authResult.session;

  const messages = await prisma.chatMessage.findMany({
    where: { sessionId },
    orderBy: { createdAt: "asc" },
    include: {
      attachments: true,
    },
  });

  // Source of truth: Redis tracks active generations (ephemeral — cleared on crash).
  // processingSince is a DB timestamp that survives crashes and must not be trusted.
  const isGenerating = await isSessionActive(authResult.userId, sessionId);

  // The active tool (if any) is persisted by the session event tracker at
  // tool_execution_start and cleared at tool_execution_end. It lets a client
  // that connects/refreshes mid-tool — when the SSE buffer replay is
  // unavailable (expired/trimmed) — show what Pi is running instead of a
  // bare "Thinking…".
  const activeTool =
    isGenerating && chatSession.activeToolCallId
      ? {
          toolCallId: chatSession.activeToolCallId,
          name: chatSession.activeToolName,
          args: chatSession.activeToolArgs as Record<string, unknown> | null,
          startedAt: chatSession.activeToolStartedAt?.toISOString() ?? null,
        }
      : null;

  return NextResponse.json({
    session: {
      id: chatSession.id,
      temporary: chatSession.temporary,
      modelProvider: chatSession.modelProvider,
      modelName: chatSession.modelName,
      thinkingLevel: chatSession.thinkingLevel,
      toolConfig: chatSession.toolConfig,
      isGenerating,
      activeTool,
    },
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      thinking: m.thinking || undefined,
      errorMessage: m.errorMessage || undefined,
      toolCalls: m.toolCalls
        ? JSON.parse(m.toolCalls).map((tc: { isError?: boolean }) => ({
            ...tc,
            status: tc.isError ? ("error" as const) : ("completed" as const),
          }))
        : undefined,
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
      ...(m.role === "compaction"
        ? {
            compaction: {
              tokensBefore: m.thinking ? parseInt(m.thinking, 10) : 0,
            },
          }
        : {}),
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
  const { sessionId } = await params;

  const authResult = await requireChatSessionOwner(sessionId);
  if (!authResult.ok) return authResult.response;
  const chatSession = authResult.session;

  // Prevent sending another message while one is being processed
  if (await isSessionActive(authResult.userId, sessionId)) {
    return NextResponse.json(
      { error: "A response is already being generated. Please wait." },
      { status: 409 },
    );
  }

  try {
    let content: string;
    const attachments: Array<{
      stored: StoredChatFile;
      fileName: string;
      mimeType: string;
      size: number;
      /** Absolute path in the agent workspace, or null when not delivered. */
      agentPath: string | null;
    }> = [];

    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      // Multipart: extract text content + files
      const formData = await request.formData();
      content = (formData.get("content") as string) || "";

      // Store each file (host-side) and copy it into the agent's terminal
      // workspace so the agent's file tools can view and manipulate it.
      const files = formData.getAll("files");
      for (const file of files) {
        if (!(file instanceof File)) continue;

        const error = validateChatFile(file);
        if (error) {
          return NextResponse.json({ error }, { status: 400 });
        }

        const mimeType = file.type || "application/octet-stream";
        const buffer = Buffer.from(await file.arrayBuffer());
        const stored = await storeChatFile(authResult.userId, buffer, file.name, mimeType);

        // Throws when the terminal is configured but unreachable — a
        // non-image file would be useless to the agent without the copy.
        const agentPath = await deliverChatFileToAgent(authResult.userId, buffer, stored.safeName);

        attachments.push({ stored, fileName: file.name, mimeType, size: file.size, agentPath });
      }
    } else {
      // JSON: plain text message
      const body = await request.json();
      content = body.content as string;
    }

    if (typeof content !== "string") {
      return NextResponse.json({ error: "Content is required" }, { status: 400 });
    }
    if (!content.trim() && attachments.length === 0) {
      return NextResponse.json({ error: "Content is required" }, { status: 400 });
    }

    // Strip null bytes and limit length
    const sanitizedContent = content.replace(/\0/g, "").slice(0, 100_000);

    // Append file-reference lines so the model knows where uploaded files
    // live (same convention as Telegram documents).
    const promptContent =
      attachments.length > 0
        ? `${sanitizedContent ? `${sanitizedContent}\n` : ""}${buildAttachmentPromptText(
            attachments.map((att) => ({
              fileName: att.fileName,
              mimeType: att.mimeType,
              agentPath: att.agentPath,
            })),
          )}`
        : sanitizedContent;

    // Save user message with attachments in a single transaction
    const userMessage = await prisma.chatMessage.create({
      data: {
        sessionId,
        role: "user",
        content: promptContent,
        ...(attachments.length > 0 && {
          attachments: {
            create: attachments.map((att) => ({
              storageId: att.stored.storageId,
              fileName: att.fileName,
              mimeType: att.mimeType,
              size: att.size,
              width: att.stored.width ?? null,
              height: att.stored.height ?? null,
              storagePath: att.stored.storagePath,
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

    // Update session metadata — sending a message is real chat activity, so
    // also advance lastActivityAt (the UI's sort/display timestamp).
    const titleSource = sanitizedContent || attachments[0]?.fileName || "Attachment";
    await prisma.chatSession.update({
      where: { id: sessionId },
      data: {
        messageCount: { increment: 1 },
        lastActivityAt: new Date(),
        title:
          chatSession.title === "New Chat"
            ? titleSource.slice(0, 47) + (titleSource.length > 47 ? "..." : "")
            : chatSession.title,
      },
    });

    // Register in Redis so the 409 guard works before the SSE connection is made.
    // Cleared by unregisterActiveSession on agent_end or stop.
    await registerActiveSession(authResult.userId, sessionId);

    // Claim the prompt: the SSE connection for this message is the expected
    // prompter. The stream route atomically claims this key — exactly one
    // connection prompts, all others observe.
    await setPendingPrompt(sessionId, userMessage.id);

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
      {
        error:
          err instanceof Error
            ? `Failed to process message: ${err.message}`
            : "Internal server error",
      },
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
  const { sessionId } = await params;

  const authResult = await requireChatSessionOwner(sessionId);
  if (!authResult.ok) return authResult.response;

  const url = new URL(request.url);
  const messageId = url.searchParams.get("id");

  if (!messageId) {
    return NextResponse.json({ error: "Message ID is required" }, { status: 400 });
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
      await deleteAllImages(authResult.userId, storagePaths);
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

  // Deleting a message modifies the conversation — advance lastActivityAt so
  // the chat reflects the modification in the list ordering.
  await prisma.chatSession
    .update({
      where: { id: sessionId },
      data: { lastActivityAt: new Date() },
    })
    .catch((err) => {
      console.error(`Failed to bump lastActivityAt after deleting message ${messageId}:`, err);
    });

  return NextResponse.json({ ok: true });
}
