/**
 * Session-scoped DB persistence for chat agent events.
 *
 * Subscribed exactly once per pooled session — independent of how many
 * SSE connections wire up. This is the single place where agent events
 * trigger database writes.
 *
 * The SSE stream route is purely an observer: it subscribes to the same
 * agent events and forwards them to connected clients, but performs no
 * writes itself.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { saveCompactionMessage } from "@/lib/chat/compaction";
import { saveAssistantMessage } from "./stream-helpers";
import { normalizeToolResult } from "./message-replay";
import { clearProcessingSince } from "./processing-state";
import { unregisterActiveSession } from "@/lib/redis";
import { getDispatcher } from "./agent-pool";

/** Per-session persistence state (one entry per pooled session). */
interface PersistenceState {
  /** Unsubscribe from agent events (called on pool eviction). */
  unsubscribe: () => void;
}

/** In-memory store: sessionId → persistence state. */
const persistenceMap = new Map<string, PersistenceState>();

/**
 * Wire DB persistence for a pooled session.
 *
 * Called exactly once when a session enters the pool. All subsequent SSE
 * connections are pure observers — they never trigger writes.
 *
 * @param sessionId - ChatSession.id from DB
 * @param userId - Authenticated user ID (for unregisterActiveSession)
 * @param session - The AgentSession to subscribe to
 */
export function wireSessionPersistence(
  sessionId: string,
  userId: string,
  session: AgentSession,
): void {
  // Guard: only wire once per session
  if (persistenceMap.has(sessionId)) return;

  const log = (tag: string, ...args: unknown[]) =>
    // eslint-disable-next-line no-console
    console.log(`[persistence:${sessionId}] ${tag}`, ...args);

  const dispatcher = getDispatcher(sessionId);

  // ── Turn state ──────────────────────────────────────────────────────
  let turnIndex = 0;
  let currentTurnText = "";
  let currentTurnThinking = "";
  let rootMessageId: string | null = null;
  // Track the pending save promise from turn_end so agent_end can await it.
  // Without this, agent_end runs synchronously before the .then() microtask
  // sets rootMessageId, causing a duplicate message create.
  let lastTurnSavePromise: Promise<{ id: string }> | null = null;

  // Tool call results tracking
  const toolCallResults: Map<
    string,
    { name: string; args: Record<string, unknown>; result?: string; isError?: boolean }
  > = new Map();

  // Token usage tracking
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let contextWindow = 0;

  // Guard: agent_end DB persistence runs exactly once
  let agentEndPersisted = false;

  // Track all pending DB saves so we can await them before emitting "done"
  const pendingSaves: Promise<void>[] = [];

  // ── Subscribe to agent events ───────────────────────────────────────
  const unsubscribe = session.subscribe((event) => {
    log(
      "event",
      event.type,
      "message" in event && event.message ? { role: event.message.role } : undefined,
    );

    switch (event.type) {
      // ── Token usage tracking ──────────────────────────────────────────
      case "message_end": {
        if (event.message.role !== "assistant") break;

        const msg = event.message as unknown as Record<string, unknown>;
        const usage = msg.usage as Record<string, number> | undefined;
        if (!usage) break;

        totalInputTokens += usage.input ?? 0;
        totalOutputTokens += usage.output ?? 0;
        totalCacheReadTokens += usage.cacheRead ?? 0;
        totalCacheWriteTokens += usage.cacheWrite ?? 0;

        if (!contextWindow) {
          contextWindow = session.model?.contextWindow ?? 0;
        }

        dispatcher.emit("token_usage", {
          input: totalInputTokens,
          output: totalOutputTokens,
          cacheRead: totalCacheReadTokens,
          cacheWrite: totalCacheWriteTokens,
          total: totalInputTokens + totalOutputTokens,
          contextWindow,
        });

        // Auto-compaction at 85% context window
        const compactionThreshold = contextWindow * 0.85;
        if (totalInputTokens + totalOutputTokens > compactionThreshold) {
          log(
            "compaction",
            `auto-triggering (${totalInputTokens + totalOutputTokens}/${contextWindow})`,
          );
          session
            .compact()
            .then((result) => {
              log("compaction", `completed: ${result?.tokensBefore ?? "unknown"} tokens before`);
            })
            .catch((err) => {
              console.error("Auto-compaction failed:", err);
            });
        }
        break;
      }

      // ── Streaming text + thinking ─────────────────────────────────────
      case "message_update": {
        if (event.message.role !== "assistant") return;
        const msg = event.message as { content: unknown[] };

        // Thinking
        const thinkingBlock = msg.content.find(
          (c) =>
            typeof c === "object" &&
            c !== null &&
            (c as Record<string, unknown>).type === "thinking",
        );
        if (thinkingBlock && typeof thinkingBlock === "object" && "thinking" in thinkingBlock) {
          currentTurnThinking = (thinkingBlock as Record<string, unknown>).thinking as string;
          dispatcher.emit("thinking", { thinking: currentTurnThinking });
        }

        // Cumulative text
        const textBlocks = msg.content.filter(
          (c) =>
            typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "text",
        );
        currentTurnText = textBlocks
          .map((c) => ((c as Record<string, unknown>).text as string) || "")
          .join("");
        if (currentTurnText) {
          dispatcher.emit("token", { text: currentTurnText });
        }
        break;
      }

      // ── Tool execution ────────────────────────────────────────────────
      case "tool_execution_start": {
        toolCallResults.set(event.toolCallId, {
          name: event.toolName,
          args: event.args,
        });
        dispatcher.emit("tool_start", {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });

        // Persist active tool to DB (for page refresh mid-tool)
        prisma.chatSession
          .update({
            where: { id: sessionId },
            data: {
              activeToolCallId: event.toolCallId,
              activeToolName: event.toolName,
              activeToolArgs: event.args,
              activeToolStartedAt: new Date(),
            },
          })
          .catch((err) => {
            console.error("Failed to persist active tool state:", err);
          });
        break;
      }

      case "tool_execution_end": {
        const resultStr = normalizeToolResult(event.result);
        const existing = toolCallResults.get(event.toolCallId);
        if (existing) {
          existing.result = resultStr;
          existing.isError = event.isError;
        }
        dispatcher.emit("tool_end", {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: resultStr,
          isError: event.isError,
        });

        // Clear active tool from DB
        prisma.chatSession
          .update({
            where: { id: sessionId },
            data: {
              activeToolCallId: null,
              activeToolName: null,
              activeToolArgs: Prisma.JsonNull,
              activeToolStartedAt: null,
            },
          })
          .catch((err) => {
            console.error("Failed to clear active tool state:", err);
          });
        break;
      }

      // ── Turn boundary ─────────────────────────────────────────────────
      case "turn_end": {
        log("turn_end", `turnIndex=${turnIndex}, textLen=${currentTurnText.length}`);

        // Flush final token/thinking before turn_end
        if (currentTurnText) {
          dispatcher.emit("token", { text: currentTurnText });
        }
        if (currentTurnThinking) {
          dispatcher.emit("thinking", { thinking: currentTurnThinking });
        }

        const assistantMsg =
          event.message.role === "assistant" ? (event.message as { content: unknown[] }) : null;
        const toolCallBlocks = assistantMsg
          ? (assistantMsg.content.filter(
              (c) =>
                typeof c === "object" &&
                c !== null &&
                (c as Record<string, unknown>).type === "toolCall",
            ) as Record<string, unknown>[])
          : [];
        const turnToolCalls = toolCallBlocks.map((tc) => {
          const result = toolCallResults.get(tc.id as string);
          return {
            id: tc.id as string,
            name: tc.name as string,
            args: tc.arguments as unknown as Record<string, unknown>,
            result: result?.result,
            isError: result?.isError,
          };
        });

        // Save to DB, then notify clients with the real ID.
        // Store the save promise so agent_end can await it — without this,
        // agent_end runs synchronously before the .then() microtask sets
        // rootMessageId, causing a duplicate message create.
        const turnIndexForSave = turnIndex;
        const turnSavePromise = saveAssistantMessage(
          sessionId,
          currentTurnText,
          currentTurnThinking || undefined,
          turnToolCalls.length > 0 ? turnToolCalls : undefined,
          rootMessageId,
        );
        lastTurnSavePromise = turnSavePromise;

        pendingSaves.push(
          turnSavePromise
            .then((msg) => {
              log("db_save", `turnIndex=${turnIndexForSave}, msgId=${msg.id}`);
              if (!rootMessageId) {
                rootMessageId = msg.id;
              }
              dispatcher.emit("message_saved", {
                messageId: msg.id,
                turnIndex: turnIndexForSave,
              });
            })
            .catch((err) => {
              console.error(`Failed to save assistant message for turn ${turnIndexForSave}:`, err);
            }),
        );

        dispatcher.emit("turn_end", {
          turnIndex,
          text: currentTurnText,
          thinking: currentTurnThinking || null,
          toolCalls: turnToolCalls,
        });

        turnIndex++;
        currentTurnText = "";
        currentTurnThinking = "";
        break;
      }

      // ── Compaction ────────────────────────────────────────────────────
      case "compaction_start": {
        dispatcher.emit("compaction_start", { reason: event.reason });
        break;
      }

      case "compaction_end": {
        if (event.result && !event.aborted) {
          void saveCompactionMessage({
            sessionId,
            summary: event.result.summary,
            tokensBefore: event.result.tokensBefore,
          });

          dispatcher.emit("compaction_end", {
            reason: event.reason,
            tokensBefore: event.result.tokensBefore,
            summary: event.result.summary,
            aborted: false,
            errorMessage: undefined,
          });
        } else {
          dispatcher.emit("compaction_end", {
            reason: event.reason,
            tokensBefore: undefined,
            summary: undefined,
            aborted: event.aborted,
            errorMessage: event.errorMessage,
          });
        }

        clearProcessingSince(sessionId).catch((err) => {
          console.error("Failed to clear processingSince after compaction:", err);
        });
        break;
      }

      // ── Agent finished ────────────────────────────────────────────────
      case "agent_end": {
        log("agent_end", `totalMessages=${event.messages.length}, turnIndex=${turnIndex}`);

        // Atomic guard: only persists to DB once
        if (!agentEndPersisted) {
          agentEndPersisted = true;
          log("agent_end", `persisting to DB (totalMessages=${event.messages.length})`);

          const assistantMessages = event.messages
            .filter((m) => m.role === "assistant")
            .map((m) => m as { role: "assistant"; content: unknown[] });
          const lastAssistant = assistantMessages[assistantMessages.length - 1];

          if (lastAssistant) {
            const textBlocks = lastAssistant.content.filter(
              (c) =>
                typeof c === "object" &&
                c !== null &&
                (c as Record<string, unknown>).type === "text",
            );
            const finalText = textBlocks
              .map((c) => ((c as Record<string, unknown>).text as string) || "")
              .join("");

            const thinkingBlock = lastAssistant.content.find(
              (c) =>
                typeof c === "object" &&
                c !== null &&
                (c as Record<string, unknown>).type === "thinking",
            );
            const finalThinking =
              thinkingBlock && typeof thinkingBlock === "object" && "thinking" in thinkingBlock
                ? ((thinkingBlock as Record<string, unknown>).thinking as string)
                : "";

            const toolCallBlocks = lastAssistant.content.filter(
              (c) =>
                typeof c === "object" &&
                c !== null &&
                (c as Record<string, unknown>).type === "toolCall",
            ) as Record<string, unknown>[];
            const toolCalls = toolCallBlocks.map((tc) => {
              const result = toolCallResults.get(tc.id as string);
              return {
                id: tc.id as string,
                name: tc.name as string,
                args: tc.arguments as unknown as Record<string, unknown>,
                result: result?.result,
                isError: result?.isError,
              };
            });

            // Finalize: update existing message (multi-turn) or create new (single-turn).
            // Chain after turn_end save if it's still pending — without this,
            // agent_end runs synchronously before the .then() microtask sets
            // rootMessageId, causing a duplicate message create.
            const basePromise = lastTurnSavePromise ?? Promise.resolve(null);
            lastTurnSavePromise = null;

            pendingSaves.push(
              basePromise
                .then((turnResult) => {
                  const existingMessageId = turnResult?.id ?? rootMessageId ?? undefined;
                  return saveAssistantMessage(
                    sessionId,
                    finalText,
                    finalThinking || undefined,
                    toolCalls.length > 0 ? toolCalls : undefined,
                    null,
                    existingMessageId,
                  ).then((msg) => ({ msg, existingMessageId }));
                })
                .then(({ msg, existingMessageId }) => {
                  log(
                    "db_save",
                    `agent_end ${existingMessageId ? "updated" : "created"} msgId=${msg.id}`,
                  );
                  const turnIndexForSave = existingMessageId ? turnIndex - 1 : 0;
                  dispatcher.emit("message_saved", {
                    messageId: msg.id,
                    turnIndex: Math.max(0, turnIndexForSave),
                  });
                })
                .catch((err) => {
                  console.error("Failed to save agent_end assistant message:", err);
                }),
            );
          }

          // Always clear processingSince and increment message count
          Promise.all([
            clearProcessingSince(sessionId),
            prisma.chatSession.update({
              where: { id: sessionId },
              data: { messageCount: { increment: turnIndex || 1 } },
            }),
          ]).catch(console.error);

          unregisterActiveSession(userId, sessionId).catch(console.error);
        }

        // Wait for all DB saves to complete before emitting "done"
        void Promise.allSettled(pendingSaves).then(() => {
          dispatcher.emit("done", {});
          unsubscribe();
          persistenceMap.delete(sessionId);
        });
        break;
      }
    }
  });

  persistenceMap.set(sessionId, { unsubscribe });
}

/**
 * Remove persistence handler for a session (called on pool eviction).
 */
export function unwireSessionPersistence(sessionId: string): void {
  const state = persistenceMap.get(sessionId);
  if (state) {
    state.unsubscribe();
    persistenceMap.delete(sessionId);
  }
}
