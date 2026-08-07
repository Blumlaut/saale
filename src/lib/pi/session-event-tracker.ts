/**
 * Shared agent-event tracker for chat sessions.
 *
 * Converts Pi agent lifecycle events into:
 *  - stream events published on the session event bus (turn_start, token,
 *    thinking, tool_start, tool_end, turn_end, message_saved, token_usage,
 *    compaction_*, done) so every connected SSE client — in any process —
 *    observes the generation live, and
 *  - database writes (assistant messages, active tool state, token usage,
 *    message count, active-session bookkeeping).
 *
 * Used by BOTH the web chat persistence layer and the Telegram processor so
 * the two code paths stay identical and any change applies everywhere.
 *
 * Stream protocol (turnId-based):
 *  - `turn_start { turnId }` — a new assistant turn begins
 *  - `token { turnId, text }` / `thinking { turnId, thinking }` — cumulative
 *  - `tool_start { turnId, toolCallId, toolName, args }`
 *  - `tool_update { turnId, toolCallId, partialResult }` — live progress from
 *    a running tool (Pi's tool_execution_update, e.g. bash streaming output)
 *  - `tool_end { turnId, toolCallId, result, isError }`
 *  - `turn_end { turnId, text?, thinking? }` — turn finalized
 *  - `message_saved { turnId, messageId }` — swap temp ID for the DB ID
 *  - `done {}` — run finished (emitted after all DB saves settle)
 */

import crypto from "crypto";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { saveCompactionMessage } from "@/lib/chat/compaction";
import { registerActiveSession, unregisterActiveSession } from "@/lib/redis";
import { normalizeToolResult } from "./message-replay";
import { publishSessionEvent, resetSessionEvents } from "./session-events";
import { buildFinalAssistantMessage } from "./stream-logic";
import { saveAssistantMessage } from "./stream-helpers";

export interface SessionEventTrackerOptions {
  sessionId: string;
  userId: string;
  session: AgentSession;
  /** Auto-compact at 85% of the context window (web chat only). */
  autoCompact?: boolean;
  /** Called once after the run ends and the `done` event has been published. */
  onDone?: () => void;
}

export interface SessionEventTracker {
  /** Stop listening to agent events. Safe to call multiple times. */
  dispose(): void;
}

interface ToolCallResult {
  name: string;
  args: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

export function createSessionEventTracker(
  options: SessionEventTrackerOptions,
): SessionEventTracker {
  const { sessionId, userId, session, autoCompact = true } = options;

  const log = (tag: string, ...args: unknown[]) =>
    // eslint-disable-next-line no-console
    console.log(`[tracker:${sessionId}] ${tag}`, ...args);

  // ── Turn state ───────────────────────────────────────────────────────────
  let turnIndex = 0;
  let currentTurnId: string | null = null;
  let currentTurnText = "";
  let currentTurnThinking = "";
  let rootMessageId: string | null = null;
  // Track the pending save promise from turn_end so agent_end can await it —
  // without this, agent_end runs before the .then() microtask sets
  // rootMessageId, causing a duplicate message create.
  let lastTurnSavePromise: Promise<{ id: string }> | null = null;

  // Tool call results tracking
  const toolCallResults = new Map<string, ToolCallResult>();

  // Throttle map for tool_execution_update forwarding — bash emits output
  // updates at ~100ms intervals; flooding the Redis buffer + SSE would be
  // wasteful. One forwarded update per tool call per second is plenty to
  // prove the run is alive and to show progress.
  const toolLastUpdateAt = new Map<string, number>();
  const TOOL_UPDATE_THROTTLE_MS = 1000;

  // Token usage tracking
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let contextWindow = 0;

  // Guard: agent_end DB persistence runs exactly once
  let agentEndPersisted = false;

  // Track all pending DB saves so "done" can wait for them
  const pendingSaves: Promise<unknown>[] = [];

  /** Start a new turn: generate a turnId and announce it on the bus. */
  const startTurn = (): string => {
    if (!currentTurnId) {
      currentTurnId = crypto.randomUUID();
      publishSessionEvent(sessionId, "turn_start", { turnId: currentTurnId }).catch((err) => {
        console.error("Failed to publish turn_start:", err);
      });
    }
    return currentTurnId;
  };

  // ── Subscribe to agent events ───────────────────────────────────────────
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    try {
      handleEvent(event);
    } catch (err) {
      console.error(`Session event tracker failed for ${sessionId}:`, err);
    }
  });

  // ── Activity heartbeat: align the Redis active-flag with Pi's REAL state ──
  // `session.isStreaming` is Pi's ground truth. Events are only a proxy for
  // it, and a long tool call that emits nothing would let the flag's TTL
  // expire mid-run (drift) — the 409 guard would stop blocking sends while
  // Pi is genuinely busy, and the stale-generation logic could misfire.
  // While Pi streams, refresh the flag periodically so Saale's view never
  // drifts from Pi's.
  const ACTIVE_SESSION_HEARTBEAT_MS = 30_000;
  let activityTimer: ReturnType<typeof setInterval> | null = null;
  const startActivityHeartbeat = () => {
    if (activityTimer) return;
    activityTimer = setInterval(() => {
      if (!session.isStreaming) return;
      registerActiveSession(userId, sessionId).catch((err) => {
        console.error("Failed to refresh active session flag:", err);
      });
    }, ACTIVE_SESSION_HEARTBEAT_MS);
    activityTimer.unref?.();
  };
  const stopActivityHeartbeat = () => {
    if (activityTimer) {
      clearInterval(activityTimer);
      activityTimer = null;
    }
  };

  function handleEvent(event: AgentSessionEvent): void {
    log(
      "event",
      event.type,
      "message" in event && event.message ? { role: event.message.role } : undefined,
    );

    switch (event.type) {
      // ── New run: reset the event buffer so stale events from previous
      //    runs are never replayed. The counter survives (see clearBuffer).
      case "agent_start": {
        resetSessionEvents(sessionId).catch((err) => {
          console.error("Failed to reset session events:", err);
        });
        startActivityHeartbeat();
        break;
      }

      // ── Token usage tracking + auto-compaction ───────────────────────────
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

        publishSessionEvent(sessionId, "token_usage", {
          input: totalInputTokens,
          output: totalOutputTokens,
          cacheRead: totalCacheReadTokens,
          cacheWrite: totalCacheWriteTokens,
          total: totalInputTokens + totalOutputTokens,
          contextWindow,
        }).catch((err) => {
          console.error("Failed to publish token_usage:", err);
        });

        if (autoCompact && contextWindow > 0) {
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
        }
        break;
      }

      // ── Streaming text + thinking ────────────────────────────────────────
      case "message_update": {
        if (event.message.role !== "assistant") return;
        const msg = event.message as { content: unknown[] };
        const turnId = startTurn();

        // Thinking (cumulative)
        const thinkingBlock = msg.content.find(
          (c) =>
            typeof c === "object" &&
            c !== null &&
            (c as Record<string, unknown>).type === "thinking",
        );
        if (thinkingBlock && typeof thinkingBlock === "object" && "thinking" in thinkingBlock) {
          currentTurnThinking = (thinkingBlock as Record<string, unknown>).thinking as string;
          publishSessionEvent(sessionId, "thinking", {
            turnId,
            thinking: currentTurnThinking,
          }).catch((err) => {
            console.error("Failed to publish thinking:", err);
          });
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
          publishSessionEvent(sessionId, "token", { turnId, text: currentTurnText }).catch(
            (err) => {
              console.error("Failed to publish token:", err);
            },
          );
        }
        break;
      }

      // ── Tool execution ───────────────────────────────────────────────────
      case "tool_execution_start": {
        const turnId = startTurn();
        toolCallResults.set(event.toolCallId, {
          name: event.toolName,
          args: event.args,
        });
        publishSessionEvent(sessionId, "tool_start", {
          turnId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        }).catch((err) => {
          console.error("Failed to publish tool_start:", err);
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

      // ── Tool live progress (Pi's tool_execution_update) ────────────────
      // Forwarded so the UI can prove Pi is still working during long tool
      // calls instead of assuming it. Throttled per tool call. Every
      // published event also refreshes the Redis buffer/counter TTLs, so a
      // long tool's progress stream keeps the event-ID counter alive.
      case "tool_execution_update": {
        const now = Date.now();
        if (now - (toolLastUpdateAt.get(event.toolCallId) ?? 0) < TOOL_UPDATE_THROTTLE_MS) {
          break;
        }
        toolLastUpdateAt.set(event.toolCallId, now);
        publishSessionEvent(sessionId, "tool_update", {
          turnId: currentTurnId ?? startTurn(),
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          partialResult: normalizeToolResult(event.partialResult),
        }).catch((err) => {
          console.error("Failed to publish tool_update:", err);
        });
        break;
      }

      case "tool_execution_end": {
        const resultStr = normalizeToolResult(event.result);
        toolLastUpdateAt.delete(event.toolCallId);
        const existing = toolCallResults.get(event.toolCallId);
        if (existing) {
          existing.result = resultStr;
          existing.isError = event.isError;
        }
        publishSessionEvent(sessionId, "tool_end", {
          turnId: currentTurnId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: resultStr,
          isError: event.isError,
        }).catch((err) => {
          console.error("Failed to publish tool_end:", err);
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

      // ── Turn boundary ───────────────────────────────────────────────────
      case "turn_end": {
        log("turn_end", `turnIndex=${turnIndex}, textLen=${currentTurnText.length}`);

        const turnId = currentTurnId ?? crypto.randomUUID();

        // Flush final token/thinking before turn_end
        if (currentTurnText) {
          publishSessionEvent(sessionId, "token", { turnId, text: currentTurnText }).catch(
            (err) => {
              console.error("Failed to publish final token:", err);
            },
          );
        }
        if (currentTurnThinking) {
          publishSessionEvent(sessionId, "thinking", {
            turnId,
            thinking: currentTurnThinking,
          }).catch((err) => {
            console.error("Failed to publish final thinking:", err);
          });
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

        // Save to DB, then notify clients with the real ID. Store the save
        // promise so agent_end can await it (avoids a duplicate create).
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
              return publishSessionEvent(sessionId, "message_saved", {
                turnId,
                messageId: msg.id,
              });
            })
            .catch((err) => {
              console.error(`Failed to save assistant message for turn ${turnIndexForSave}:`, err);
            }),
        );

        publishSessionEvent(sessionId, "turn_end", {
          turnId,
          text: currentTurnText,
          thinking: currentTurnThinking || null,
          toolCalls: turnToolCalls,
        }).catch((err) => {
          console.error("Failed to publish turn_end:", err);
        });

        turnIndex++;
        currentTurnId = null;
        currentTurnText = "";
        currentTurnThinking = "";
        break;
      }

      // ── Compaction ──────────────────────────────────────────────────────
      case "compaction_start": {
        publishSessionEvent(sessionId, "compaction_start", { reason: event.reason }).catch(
          (err) => {
            console.error("Failed to publish compaction_start:", err);
          },
        );
        break;
      }

      case "compaction_end": {
        if (event.result && !event.aborted) {
          void saveCompactionMessage({
            sessionId,
            summary: event.result.summary,
            tokensBefore: event.result.tokensBefore,
          });

          publishSessionEvent(sessionId, "compaction_end", {
            reason: event.reason,
            tokensBefore: event.result.tokensBefore,
            summary: event.result.summary,
            aborted: false,
            errorMessage: undefined,
          }).catch((err) => {
            console.error("Failed to publish compaction_end:", err);
          });
        } else {
          publishSessionEvent(sessionId, "compaction_end", {
            reason: event.reason,
            tokensBefore: undefined,
            summary: undefined,
            aborted: event.aborted,
            errorMessage: event.errorMessage,
          }).catch((err) => {
            console.error("Failed to publish compaction_end:", err);
          });
        }
        break;
      }

      // ── Agent finished ───────────────────────────────────────────────────
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
            const { text, thinking, toolCalls } = buildFinalAssistantMessage(
              lastAssistant.content,
              toolCallResults,
            );
            const turnId = currentTurnId ?? crypto.randomUUID();

            // Finalize: update existing message (multi-turn) or create new
            // (single-turn). Chain after turn_end save if still pending.
            const basePromise = lastTurnSavePromise ?? Promise.resolve(null);
            lastTurnSavePromise = null;

            pendingSaves.push(
              basePromise
                .then((turnResult) => {
                  const existingMessageId = turnResult?.id ?? rootMessageId ?? undefined;
                  return saveAssistantMessage(
                    sessionId,
                    text,
                    thinking || undefined,
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
                  return publishSessionEvent(sessionId, "message_saved", {
                    turnId,
                    messageId: msg.id,
                  });
                })
                .catch((err) => {
                  console.error("Failed to save agent_end assistant message:", err);
                }),
            );
          }

          // Unregister the active session and bump the message count once.
          Promise.all([
            unregisterActiveSession(userId, sessionId),
            prisma.chatSession.update({
              where: { id: sessionId },
              data: { messageCount: { increment: turnIndex || 1 } },
            }),
          ]).catch((err) => {
            console.error("Failed to finalize session bookkeeping:", err);
          });
        }

        // Wait for all DB saves to complete before emitting "done" — but
        // don't block agent_end settlement (other listeners still run).
        stopActivityHeartbeat();
        void Promise.allSettled(pendingSaves).then(() => {
          publishSessionEvent(sessionId, "done", {}).catch((err) => {
            console.error("Failed to publish done:", err);
          });
          options.onDone?.();
          unsubscribe();
        });
        break;
      }
    }
  }

  return {
    dispose() {
      stopActivityHeartbeat();
      unsubscribe();
    },
  };
}
