import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireChatSessionOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { deleteChatSession } from "@/lib/chat/delete-session";
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
  const { title, temporary, modelProvider, modelName, thinkingLevel, toolConfig } = body;

  // Build data only for fields that actually differ from current values (skip unchanged to avoid touching updatedAt)
  const data: Record<string, unknown> = {};
  if (title && title !== authResult.session.title) data.title = title;
  if (typeof temporary === "boolean" && temporary !== authResult.session.temporary)
    data.temporary = temporary;
  if (modelProvider && modelProvider !== authResult.session.modelProvider)
    data.modelProvider = modelProvider;
  if (modelName && modelName !== authResult.session.modelName) data.modelName = modelName;
  if (thinkingLevel && thinkingLevel !== authResult.session.thinkingLevel)
    data.thinkingLevel = thinkingLevel;
  if (toolConfig && JSON.stringify(toolConfig) !== JSON.stringify(authResult.session.toolConfig))
    data.toolConfig = toolConfig;

  // A user-initiated change (e.g. renaming the chat) is real activity
  // advance lastActivityAt so the session list reflects the modification.
  if (Object.keys(data).length > 0) {
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
    await deleteChatSession(authResult.userId, sessionId);
  } catch (err) {
    console.error(`Failed to delete chat session ${sessionId}:`, err);
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
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const formData = await request.formData();
  if (formData.get("_method") === "DELETE") {
    return deleteSession(request, params);
  }
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
}
