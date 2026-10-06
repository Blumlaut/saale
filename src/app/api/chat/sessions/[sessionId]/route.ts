import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireChatSessionOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { deleteChatSession } from "@/lib/chat/delete-session";
import { remove, get as getPooledSession, getPoolKey } from "@/lib/pi/agent-pool";
import { buildModelRuntime } from "@/lib/pi/models";
import { isPiThinkingLevel } from "@/lib/pi/thinking-levels";

/**
 * GET /api/chat/sessions/:sessionId — Get session details
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
 * PATCH /api/chat/sessions/:sessionId — Update session (title, model, etc.)
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

  // A user-initiated change (e.g. renaming the chat) is real activity —
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
 * Apply a settings change to the chat's live agent session, when one is pooled.
 *
 * The pool holds one `AgentSession` per chat, and its model, thinking level and
 * tool loadout are fixed when it is built. Without this, a change made in the
 * UI would only take effect once that session was evicted — up to 30 minutes
 * idle, or a restart — so the chat kept answering with the previous model.
 *
 * - Model: `session.setModel()` is Pi's own primitive. It validates that auth
 *   exists and records the change in the transcript, so a session that is later
 *   resumed from disk keeps it.
 * - Thinking level: `session.setThinkingLevel()` clamps to what the model
 *   supports and records the change. Saale's "default" means "no opinion", so
 *   there is nothing to apply.
 * - Tool config: tools are resolved from the config when the session is built,
 *   so the loadout cannot be changed in place — the session is dropped instead
 *   and rebuilt on the next message. Never while a run is in flight: eviction
 *   disposes the session and would abort it.
 */
async function syncPooledAgentSession(options: {
  userId: string;
  sessionId: string;
  previous: {
    modelProvider: string | null;
    modelName: string | null;
    thinkingLevel: string;
    toolConfig: unknown;
  };
  updated: {
    modelProvider: string | null;
    modelName: string | null;
    thinkingLevel: string;
    toolConfig: unknown;
  };
}): Promise<void> {
  const { userId, sessionId, previous, updated } = options;
  const pooled = getPooledSession(getPoolKey(userId, sessionId));
  if (!pooled) return;

  const modelChanged =
    previous.modelProvider !== updated.modelProvider || previous.modelName !== updated.modelName;
  const levelChanged = previous.thinkingLevel !== updated.thinkingLevel;
  const toolsChanged = JSON.stringify(previous.toolConfig) !== JSON.stringify(updated.toolConfig);

  if (modelChanged && updated.modelProvider && updated.modelName) {
    try {
      const { modelRuntime } = await buildModelRuntime(userId);
      const model = modelRuntime.getModel(updated.modelProvider, updated.modelName);
      if (model) {
        await pooled.session.setModel(model);
      } else {
        console.error(
          `Model ${updated.modelProvider}/${updated.modelName} is not available to user ${userId}`,
        );
      }
    } catch (err) {
      console.error("Failed to switch the running agent's model:", err);
    }
  }

  if (levelChanged && isPiThinkingLevel(updated.thinkingLevel)) {
    try {
      pooled.session.setThinkingLevel(updated.thinkingLevel);
    } catch (err) {
      console.error("Failed to switch the running agent's thinking level:", err);
    }
  }

  if (toolsChanged) {
    if (pooled.session.isStreaming || pooled.promptInFlight) {
      console.warn(
        `Tool config changed for a busy chat session ${sessionId} — the new loadout applies after the current run`,
      );
    } else {
      await remove(getPoolKey(userId, sessionId));
    }
  }
}

/**
 * Delete a chat session and all its messages + attachments.
 * Used by both DELETE and sendBeacon (POST with _method=DELETE).
 *
 * The work lives in `deleteChatSession` so the `chat_delete` tool removes a
 * chat exactly the same way — files, DB rows, pooled agent and transcript.
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
 * DELETE /api/chat/sessions/:sessionId — Delete a session and all its messages
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  return deleteSession(request, params);
}

/**
 * POST /api/chat/sessions/:sessionId — Method override for sendBeacon (DELETE via POST)
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
