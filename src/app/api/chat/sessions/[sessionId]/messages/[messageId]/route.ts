import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  isSessionActive,
  registerActiveSession,
  setPendingHistoryRewind,
  setPendingPrompt,
} from "@/lib/redis";
import { get, getPoolKey } from "@/lib/pi/agent-pool";

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

  // Verify session ownership
  const chatSession = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId: authResult.user.id },
    select: { id: true },
  });

  if (!chatSession) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Check if a response is already being generated
  if (await isSessionActive(authResult.user.id, sessionId)) {
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
  // Editing here rewrites history and deletes everything after the message.
  // A queued message has no history yet — it is edited (and deleted) through
  // /queue/:messageId instead.
  if (message.queuedAt) {
    return NextResponse.json(
      { error: "Message is queued — edit it from the send queue." },
      { status: 409 },
    );
  }

  const body = await request.json();
  const { content } = body;

  if (typeof content !== "string" || !content.trim()) {
    return NextResponse.json({ error: "Content is required" }, { status: 400 });
  }

  // Sanitize content
  const sanitizedContent = content.replace(/\0/g, "").slice(0, 100_000);

  // Position of this message among the session's saved user messages — the
  // prompt path uses it to find the transcript entry the edit replaced.
  const savedUserMessages = await prisma.chatMessage.findMany({
    where: { sessionId, role: "user", queuedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  const userMessageIndex = savedUserMessages.findIndex((m) => m.id === messageId);

  // Update the message in place and delete messages after it
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
  });

  // Register in Redis so the 409 guard works before the SSE connection is made.
  await registerActiveSession(authResult.user.id, sessionId);

  // Claim the prompt: the SSE connection for the edited message is the
  // expected prompter (see stream route).
  await setPendingPrompt(sessionId, messageId);

  // The agent transcript is append-only and still holds the messages this edit
  // deleted, so the connection that prompts must rewind it first — otherwise
  // the model reads the edited text as a new message after the old one.
  await setPendingHistoryRewind(sessionId, {
    messageId,
    previousContent: message.content,
    userMessageIndex,
  });

  // Clear lastPromptedMessageId so the stream re-prompts with the edited content.
  // The message ID is the same but its content has changed.
  const poolKey = getPoolKey(authResult.user.id, sessionId);
  const pooled = get(poolKey);
  if (pooled) {
    pooled.lastPromptedMessageId = null;
  }

  return NextResponse.json({
    ok: true,
    messageId,
    streamUrl: `/api/chat/sessions/${sessionId}/stream`,
  });
}
