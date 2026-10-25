import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { redactStoredToolCalls } from "@/lib/chat/redact-tool-calls";
import type { Prisma } from "@prisma/client";

/**
 * POST /api/chat/sessions/share/:token/copy. Clone a shared session into the current user's account.
 *
 * Requires authentication. Creates a new ChatSession with all messages copied.
 * Idempotent: if the user already has a copy (tracked via sourceShareToken), returns existing session.
 *
 * Tool calls are redacted on the way in. The copier is not the data owner, and
 * without this the shared page's redaction would be bypassable by signing in
 * and copying the chat to read the raw results here.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  // Resolve the shared session
  const sourceSession = await prisma.chatSession.findFirst({
    where: { shareToken: token, shared: true },
    select: {
      id: true,
      title: true,
      modelProvider: true,
      modelName: true,
      thinkingLevel: true,
      toolConfig: true,
    },
  });

  if (!sourceSession) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Idempotency: check if user already has a copy from this share token
  const existingCopy = await prisma.chatSession.findFirst({
    where: {
      userId: authResult.user.id,
      sourceShareToken: token,
    },
    select: { id: true },
  });

  if (existingCopy) {
    return NextResponse.json({
      ok: true,
      sessionId: existingCopy.id,
      alreadyCopied: true,
    });
  }

  // Fetch all messages from source session (queued messages are not part of
  // the shared conversation)
  const sourceMessages = await prisma.chatMessage.findMany({
    where: { sessionId: sourceSession.id, queuedAt: null },
    orderBy: { createdAt: "asc" },
    select: {
      role: true,
      content: true,
      thinking: true,
      toolCalls: true,
      parentMessageId: true,
      createdAt: true,
    },
  });

  // Count messages for the new session
  const messageCount = sourceMessages.length;

  // Create the cloned session with all messages in a transaction
  const clonedSession = await prisma.$transaction(async (tx) => {
    const newSession = await tx.chatSession.create({
      data: {
        userId: authResult.user.id,
        title: sourceSession.title.slice(0, 47) + (sourceSession.title.length > 47 ? "..." : ""),
        // a copy keeps its title, the title job must not rename it back
        titleSource: "user",
        temporary: false,
        modelProvider: sourceSession.modelProvider,
        modelName: sourceSession.modelName,
        thinkingLevel: sourceSession.thinkingLevel,
        toolConfig: sourceSession.toolConfig as Prisma.InputJsonValue,
        messageCount,
        sourceShareToken: token,
        messages: {
          create: sourceMessages.map((m) => ({
            role: m.role,
            content: m.content,
            thinking: m.thinking,
            toolCalls: redactStoredToolCalls(m.toolCalls),
            parentMessageId: m.parentMessageId,
            // Preserve original timestamps
            createdAt: m.createdAt,
          })),
        },
      },
      select: {
        id: true,
      },
    });

    return newSession;
  });

  return NextResponse.json({
    ok: true,
    sessionId: clonedSession.id,
    alreadyCopied: false,
  });
}
