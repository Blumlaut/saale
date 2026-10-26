import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireChatSessionOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { autoDeleteChatSession, deleteChatSession } from "@/lib/chat/delete-session";
import { CoderCleanupError } from "@/lib/coder/worktree-removal";
import { cleanupRefusalResponse } from "@/lib/coder/cleanup-response";
import { forceRequested } from "@/lib/coder/force-delete";
import { syncPooledAgentSession } from "@/lib/pi/sync-pooled-session";

/**
 * GET /api/chat/sessions/:sessionId. Get session details
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  const authResult = await requireChatSessionOwner(sessionId);
  if (!authResult.ok) return authResult.response;

  return NextResponse.json({
    session: {
      ...authResult.session,
      createdAt: authResult.session.createdAt.toISOString(),
      updatedAt: authResult.session.updatedAt.toISOString(),
    },
  });
}

/**
 * PATCH /api/chat/sessions/:sessionId. Update session (title, model, etc.)
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  const authResult = await requireChatSessionOwner(sessionId);
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const { title, temporary, pinned, modelProvider, modelName, thinkingLevel, toolConfig } = body;

  // Build data only for fields that actually differ from current values (skip unchanged to avoid touching updatedAt)
  const data: Record<string, unknown> = {};
  if (title && title !== authResult.session.title) {
    data.title = title;
    data.titleSource = "user";
  }
  if (typeof temporary === "boolean" && temporary !== authResult.session.temporary)
    data.temporary = temporary;
  if (typeof pinned === "boolean" && pinned !== authResult.session.pinned) data.pinned = pinned;
  if (modelProvider && modelProvider !== authResult.session.modelProvider)
    data.modelProvider = modelProvider;
  if (modelName && modelName !== authResult.session.modelName) data.modelName = modelName;
  if (thinkingLevel && thinkingLevel !== authResult.session.thinkingLevel)
    data.thinkingLevel = thinkingLevel;
  if (toolConfig && JSON.stringify(toolConfig) !== JSON.stringify(authResult.session.toolConfig))
    data.toolConfig = toolConfig;

  // A user-initiated change (e.g. renaming the chat) is real activity
  // advance lastActivityAt so the session list reflects the modification.
  // Pinning is not: it must not move a chat's place in the list.
  if (Object.keys(data).some((field) => field !== "pinned")) {
    data.lastActivityAt = new Date();
  }

  const updated =
    Object.keys(data).length > 0
      ? await prisma.chatSession.update({
          where: { id: sessionId },
          data,
        })
      : authResult.session;

  await syncPooledAgentSession({
    userId: authResult.userId,
    sessionId,
    previous: authResult.session,
    updated,
  });

  return NextResponse.json({
    session: {
      id: updated.id,
      title: updated.title,
      pinned: updated.pinned,
      modelProvider: updated.modelProvider,
      modelName: updated.modelName,
      thinkingLevel: updated.thinkingLevel,
      toolConfig: updated.toolConfig,
    },
  });
}

/**
 * Delete a chat session and all its messages + attachments.
 * Used by both DELETE and sendBeacon (POST with _method=DELETE).
 *
 * The work lives in `deleteChatSession` so the `chat_delete` tool removes a
 * chat exactly the same way. files, DB rows, pooled agent and transcript.
 */
async function deleteSession(request: NextRequest, params: Promise<{ sessionId: string }>) {
  const { sessionId } = await params;

  const authResult = await requireChatSessionOwner(sessionId);
  if (!authResult.ok) return authResult.response;

  try {
    await deleteChatSession(authResult.userId, sessionId, forceRequested(request.url));
  } catch (err) {
    console.error(`Failed to delete chat session ${sessionId}:`, err);
    // A worktree git will not let go keeps the chat. the reason is the answer.
    if (err instanceof CoderCleanupError) return cleanupRefusalResponse(err);
    return NextResponse.json(
      {
        error: "Failed to delete chat",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/chat/sessions/:sessionId. Delete a session and all its messages
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  return deleteSession(request, params);
}

/**
 * POST /api/chat/sessions/:sessionId. Method override for sendBeacon (DELETE via POST)
 * sendBeacon only supports POST, so we accept _method=DELETE in the body.
 *
 * This is the path the chat takes on its way out of the browser (unmount, tab
 * close), so it is a *request* to delete an abandoned chat, not an order: the
 * server re-checks that nothing is running or being built before removing
 * anything, and always answers 200. the browser is not listening, and a chat
 * the user is still owed an answer in must never be the casualty of a stale
 * client guess (see `autoDeleteChatSession`).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const formData = await request.formData();
  if (formData.get("_method") !== "DELETE") {
    return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
  }

  const { sessionId } = await params;
  const authResult = await requireChatSessionOwner(sessionId);
  if (!authResult.ok) return authResult.response;

  try {
    const result = await autoDeleteChatSession(authResult.userId, sessionId);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    // A dirty worktree refuses the delete. the chat stays, which is the point.
    console.error(`Failed to auto-delete chat session ${sessionId}:`, err);
    return NextResponse.json({ ok: false });
  }
}
