import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireChatSessionOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { saveCompactionMessage } from "@/lib/chat/compaction";
import { resolveModelForPurpose } from "@/lib/pi/model-resolution";
import { type ToolConfig } from "@/lib/pi/session";
import { getPoolKey, getSessionDir, createAndPool } from "@/lib/pi/agent-pool";
import { buildAgentSystemPrompt } from "@/lib/pi/processing-state";
import { createPersistentSession } from "@/lib/pi/persistent-session";

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
  let modelProvider = chatSession.modelProvider || undefined;
  let modelName = chatSession.modelName || undefined;

  if (!modelProvider || !modelName) {
    const resolved = await resolveModelForPurpose(authResult.userId, "chat", undefined);
    if (resolved) {
      modelProvider = resolved.provider;
      modelName = resolved.name;
    }
  }

  if (!modelProvider || !modelName) {
    return NextResponse.json({ error: "No AI model configured" }, { status: 400 });
  }

  // Get or create pooled agent (recreates from JSONL if evicted)
  const poolKey = getPoolKey(authResult.userId, sessionId);
  const sessionDir = getSessionDir(authResult.userId, sessionId);

  const resolvedToolConfig: ToolConfig = chatSession.toolConfig
    ? { ...(chatSession.toolConfig as ToolConfig) }
    : {};

  const pooled = await createAndPool(poolKey, async () => {
    const result = await createPersistentSession({
      userId: authResult.userId,
      sessionId,
      sessionDir,
      customTools: [],
      toolConfig: resolvedToolConfig,
      modelProvider,
      modelName,
      thinkingLevel: chatSession.thinkingLevel || "off",
    });

    // Set system prompt (same as stream route)
    const userSettings = await prisma.appSettings.findUnique({
      where: { userId: authResult.userId },
      select: { agentCustomInstructions: true },
    });

    result.session.agent.state.systemPrompt = buildAgentSystemPrompt({
      customInstructions: userSettings?.agentCustomInstructions,
      toolConfig: resolvedToolConfig,
    });

    return { session: result.session, sessionDir };
  });

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
    console.error("Manual compaction failed:", err);
    return NextResponse.json({ error: "Compaction failed" }, { status: 500 });
  }
}
