import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireChatSessionOwner } from "@/lib/auth";
import {
  isSessionActive,
  registerActiveSession,
  releaseSendQueue,
  setPendingPrompt,
} from "@/lib/redis";
import {
  claimQueuedMessage,
  getQueuedMessage,
  publishQueueUpdate,
  removeQueuedMessage,
  updateQueuedMessageContent,
} from "@/lib/chat/queue";
import { serializeChatMessage } from "@/lib/chat/serialize-message";
import { get, getPoolKey } from "@/lib/pi/agent-pool";
import { readImageAsBase64 } from "@/lib/image-attachment";
import type { ImageContent } from "@/lib/pi/message-replay";

/**
 * /api/chat/sessions/:sessionId/queue/:messageId. act on one queued message.
 *
 * A queued message has not reached the agent yet, so these actions are plain
 * queue edits. they never touch the conversation. Delivery is the stream
 * route's job (see its `drainQueue`).
 *
 * - PATCH . rewrite the queued text before it is sent
 * - DELETE. cancel it (files included)
 * - POST  . send it now: steer it into the running agent, or hand it to the
 *            prompt path when the session is idle
 */

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string; messageId: string }> },
) {
  const { sessionId, messageId } = await params;

  const authResult = await requireChatSessionOwner(sessionId);
  if (!authResult.ok) return authResult.response;

  let content: unknown;
  try {
    ({ content } = (await request.json()) as { content?: unknown });
  } catch (err) {
    console.error(`Failed to parse queue edit body for ${messageId}:`, err);
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (typeof content !== "string" || !content.trim()) {
    return NextResponse.json({ error: "Content is required" }, { status: 400 });
  }

  const sanitizedContent = content.replace(/\0/g, "").slice(0, 100_000);
  const updated = await updateQueuedMessageContent(sessionId, messageId, sanitizedContent);
  if (!updated) {
    return NextResponse.json({ error: "Message is no longer queued" }, { status: 409 });
  }

  await publishQueueUpdate(sessionId);
  return NextResponse.json({ ok: true, message: serializeChatMessage(updated) });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string; messageId: string }> },
) {
  const { sessionId, messageId } = await params;

  const authResult = await requireChatSessionOwner(sessionId);
  if (!authResult.ok) return authResult.response;

  const removed = await removeQueuedMessage(authResult.userId, sessionId, messageId);
  if (!removed) {
    return NextResponse.json({ error: "Message is no longer queued" }, { status: 409 });
  }

  await publishQueueUpdate(sessionId);
  return NextResponse.json({ ok: true });
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string; messageId: string }> },
) {
  const { sessionId, messageId } = await params;

  const authResult = await requireChatSessionOwner(sessionId);
  if (!authResult.ok) return authResult.response;

  const message = await getQueuedMessage(sessionId, messageId);
  if (!message) {
    return NextResponse.json({ error: "Message is no longer queued" }, { status: 409 });
  }

  // An explicit "send now" is the user asking to keep going.
  await releaseSendQueue(sessionId);

  // Idle (nothing is generating): hand it to the prompt path exactly like a
  // fresh POST /messages. the client's SSE reconnect claims and prompts it.
  if (!(await isSessionActive(authResult.userId, sessionId))) {
    if (!(await claimQueuedMessage(sessionId, messageId))) {
      return NextResponse.json({ error: "Message is no longer queued" }, { status: 409 });
    }
    await registerActiveSession(authResult.userId, sessionId);
    await setPendingPrompt(sessionId, messageId);
    await publishQueueUpdate(sessionId);
    return NextResponse.json({ ok: true, delivered: true, mode: "prompt" });
  }

  // A generation is running in this process: steer it into the agent, which
  // delivers the message as soon as the current turn finishes its tool calls
  //. no waiting for the whole run, and no wasted work.
  const pooled = get(getPoolKey(authResult.userId, sessionId));
  if (!pooled || !pooled.session.isStreaming) {
    return NextResponse.json(
      {
        ok: false,
        delivered: false,
        error: "Pi is busy elsewhere. the message stays queued and is sent next.",
      },
      { status: 409 },
    );
  }

  const images: ImageContent[] = [];
  for (const att of message.attachments) {
    if (!att.mimeType.startsWith("image/")) continue;
    try {
      const { data, mimeType } = await readImageAsBase64(authResult.userId, att.storagePath);
      images.push({ type: "image" as const, data, mimeType });
    } catch (err) {
      console.error(`Failed to load image for steered message ${messageId}:`, err);
    }
  }

  try {
    await (images.length > 0
      ? pooled.session.steer(message.content, images)
      : pooled.session.steer(message.content));
  } catch (err) {
    console.error(`Failed to steer queued message ${messageId}:`, err);
    return NextResponse.json(
      {
        ok: false,
        delivered: false,
        error: err instanceof Error ? err.message : "Failed to send the message now",
      },
      { status: 500 },
    );
  }

  // The message is now part of the running turn: take it out of the queue so
  // the client shows it in the conversation instead of the strip.
  if (!(await claimQueuedMessage(sessionId, messageId))) {
    console.error(`Steered message ${messageId} was no longer queued`);
  }
  await publishQueueUpdate(sessionId);
  return NextResponse.json({ ok: true, delivered: true, mode: "steered" });
}
