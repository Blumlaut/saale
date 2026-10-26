import { prisma } from "@/lib/db";
import { saveCompactionMessage } from "@/lib/chat/compaction";
import { getPoolKey, createAndPool } from "@/lib/pi/agent-pool";
import {
  createChatAgentSession,
  loadChatUserSettings,
  resolveChatModel,
} from "@/lib/pi/chat-session-factory";
import { createChatApprovalEmitter } from "@/lib/pi/tool-approval-gate";
import { clearCompactionInProgress, markCompactionInProgress } from "@/lib/redis";

/**
 * Compaction failure reasons, mapped to HTTP responses by the route and to
 * tones by the `/compact` command.
 */
export type CompactChatErrorCode =
  "no-model" | "already-compacted" | "nothing-to-compact" | "failed";

export type CompactChatResult =
  | { ok: true; tokensBefore: number | undefined }
  | { ok: false; code: CompactChatErrorCode; message: string };

/**
 * The `/compact` outcome for a chat compaction, so the web and Telegram
 * surfaces say the same thing about the same result.
 */
export function compactionOutcome(result: CompactChatResult): {
  message: string;
  tone: "success" | "info" | "error";
  refresh?: "messages";
} {
  if (!result.ok) {
    // "already compacted" and "too short" are states, not failures.
    const informational =
      result.code === "already-compacted" || result.code === "nothing-to-compact";
    return { message: result.message, tone: informational ? "info" : "error" };
  }

  const tokensInfo = result.tokensBefore
    ? ` (was ${result.tokensBefore.toLocaleString()} tokens)`
    : "";
  return { message: `Conversation compacted${tokensInfo}.`, tone: "success", refresh: "messages" };
}

/** Refresh interval for the compaction flag. well inside its TTL, so a long
 * summarization never lets the session read as idle mid-compaction. */
const COMPACTION_FLAG_REFRESH_MS = 30_000;

/**
 * Manually compact a chat session's conversation.
 *
 * This summarizes the conversation history to reduce context usage, freeing up
 * room for more turns without losing key information.
 *
 * Works whether the agent is currently in the pool or has been evicted. it
 * will recreate the session from the persistent JSONL file if needed.
 *
 * For as long as the summarization runs, the session is marked as compacting:
 * Pi refuses a prompt until it finishes, so messages sent meanwhile are queued
 * (see POST /messages) and delivered once the chat is idle again.
 *
 * Shared by `POST /compact` and the `/compact` command.
 */
export async function compactChatSession(params: {
  userId: string;
  sessionId: string;
}): Promise<CompactChatResult> {
  const { userId, sessionId } = params;

  // User isolation. the caller passes an authenticated pair, but the lookup
  // must stay scoped so a bare id can never reach another user's chat.
  const chatSession = await prisma.chatSession.findFirst({ where: { id: sessionId, userId } });
  if (!chatSession) {
    return { ok: false, code: "failed", message: "Chat session not found" };
  }

  // Resolve model
  const model = await resolveChatModel(userId, chatSession);
  if (!model) {
    return { ok: false, code: "no-model", message: "No AI model configured" };
  }

  // Get or create pooled agent (recreates from JSONL if evicted). The approval
  // channel must be built here too: this route can be the one that puts the
  // session into the pool, and the gate is fixed when the agent is built.
  const poolKey = getPoolKey(userId, sessionId);
  const userSettings = await loadChatUserSettings(userId);
  const emitApprovalRequest = createChatApprovalEmitter(sessionId);

  const pooled = await createAndPool(poolKey, () =>
    createChatAgentSession({
      userId,
      sessionId,
      chatSession,
      model,
      customInstructions: userSettings.customInstructions,
      coderCustomInstructions: userSettings.coderCustomInstructions,
      toolPolicies: userSettings.toolPolicies,
      toolExposure: userSettings.toolExposure,
      emitApprovalRequest,
    }),
  );

  // A compaction holds the session until its summarization finishes. Mark it so
  // a message sent meanwhile is queued rather than prompted into Pi's "Cannot
  // submit a prompt while compaction is in progress" rejection.
  await markCompactionInProgress(sessionId);
  const flagRefresh = setInterval(() => {
    markCompactionInProgress(sessionId).catch((err) => {
      console.error(`Failed to refresh the compaction flag for ${sessionId}:`, err);
    });
  }, COMPACTION_FLAG_REFRESH_MS);

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

    return { ok: true, tokensBefore: result?.tokensBefore };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Known non-error conditions. callers surface these as informational
    if (message === "Already compacted") {
      return {
        ok: false,
        code: "already-compacted",
        message: "This conversation is already compacted",
      };
    }
    if (message === "Nothing to compact (session too small)") {
      return {
        ok: false,
        code: "nothing-to-compact",
        message: "The conversation is too short to compact",
      };
    }

    console.error("Manual compaction failed:", err);
    return { ok: false, code: "failed", message: "Compaction failed" };
  } finally {
    clearInterval(flagRefresh);
    await clearCompactionInProgress(sessionId);
  }
}
