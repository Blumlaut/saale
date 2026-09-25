import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireChatSessionOwner } from "@/lib/auth";
import { saveCompactionMessage } from "@/lib/chat/compaction";
import { getPoolKey, createAndPool } from "@/lib/pi/agent-pool";
import {
  createChatAgentSession,
  loadChatUserSettings,
  resolveChatModel,
} from "@/lib/pi/chat-session-factory";
import { createToolApprovalGate } from "@/lib/pi/tool-approval-gate";
import { publishSessionEvent } from "@/lib/pi/session-events";

/**
 * Manually trigger conversation compaction.
 *
 * This summarizes the conversation history to reduce context usage,
 * freeing up room for more turns without losing key information.
 *
 * Works whether the agent is currently in the pool or has been evicted —
 * it will recreate the session from the persistent JSONL file if needed.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  const authResult = await requireChatSessionOwner(sessionId);
  if (!authResult.ok) return authResult.response;
  const chatSession = authResult.session;

  // Resolve model
  const model = await resolveChatModel(authResult.userId, chatSession);
  if (!model) {
    return NextResponse.json({ error: "No AI model configured" }, { status: 400 });
  }

  // Get or create pooled agent (recreates from JSONL if evicted). The approval
  // gate must be applied here too: this route can be the one that puts the
  // session into the pool, and tools are only gated when the agent is built.
  const poolKey = getPoolKey(authResult.userId, sessionId);
  const userSettings = await loadChatUserSettings(authResult.userId);
  const approvalWrapper = createToolApprovalGate({
    userId: authResult.userId,
    sessionId,
    toolPolicies: userSettings.toolPolicies,
    emitApprovalRequest: (req) => {
      publishSessionEvent(sessionId, "tool_approval_request", {
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        args: req.args,
        expiresAt: new Date(req.expiresAt).toISOString(),
      }).catch((err) => {
        console.error("Failed to publish approval request:", err);
      });
    },
  });

  const pooled = await createAndPool(poolKey, () =>
    createChatAgentSession({
      userId: authResult.userId,
      sessionId,
      chatSession,
      model,
      customInstructions: userSettings.customInstructions,
      wrapTool: approvalWrapper,
    }),
  );

  try {
    const result = await pooled.session.compact();

    // Save compaction summary to DB so it appears in the chat
    if (result?.summary) {
      await saveCompactionMessage({
        sessionId,
        summary: result.summary,
        tokensBefore: result.tokensBefore,
      });
    }

    return NextResponse.json({
      compacted: true,
      tokensBefore: result?.tokensBefore,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Known non-error conditions — return 409 with actionable info
    if (message === "Already compacted") {
      return NextResponse.json(
        { error: "already_compacted", message: "This conversation is already compacted" },
        { status: 409 },
      );
    }
    if (message === "Nothing to compact (session too small)") {
      return NextResponse.json(
        { error: "nothing_to_compact", message: "The conversation is too short to compact" },
        { status: 409 },
      );
    }

    console.error("Manual compaction failed:", err);
    return NextResponse.json({ error: "Compaction failed" }, { status: 500 });
  }
}
