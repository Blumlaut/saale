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
 * Lifecycle semantics mirror Pi's TUI (callers must use `session.prompt()`,
 * NOT `session.agent.prompt()` — the former runs the SDK's post-run
 * processing): the agent run may STOP at `agent_end` but keep GOING (error
 * retry, auto-compaction + `agent.continue()` after overflow, queued
 * messages). `agent_settled` is the "completely finished" signal — only then
 * does this tracker emit `done` and dispose. Compaction is triggered by the
 * SDK itself (pre-prompt and post-run checks); the tracker only observes the
 * `compaction_start`/`compaction_end` events and persists the summary.
 * Never call `session.compact()` here: it aborts any in-flight run and, if
 * fired more than once, double-compacts the session.
 *
 * Stream protocol (turnId-based):
 *  - `turn_start { turnId, startedAt }` — a new assistant turn begins, at the
 *    server's timestamp for it (what the turn's DB row is stamped with too)
 *  - `token { turnId, text }` / `thinking { turnId, thinking }` — cumulative
 *  - `tool_start { turnId, toolCallId, toolName, args }`
 *  - `tool_update { turnId, toolCallId, partialResult }` — live progress from
 *    a running tool (Pi's tool_execution_update, e.g. bash streaming output)
 *  - `tool_end { turnId, toolCallId, result, isError }`
 *  - `turn_end { turnId, text?, thinking? }` — turn finalized
 *  - `message_saved { turnId, messageId }` — swap temp ID for the DB ID
 *  - `done {}` — run settled (emitted on agent_settled after all DB saves settle)
 */

import crypto from "crypto";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { saveCompactionMessage } from "@/lib/chat/compaction";
import { publishQueueUpdate } from "@/lib/chat/queue";
import {
  ACTIVE_SESSION_HEARTBEAT_MS,
  registerActiveSession,
  unregisterActiveSession,
} from "@/lib/redis";
import { clearSessionAbort, wasSessionAbortRequested } from "./abort-request";
import { readContextUsage } from "./context-usage";
import { normalizeToolResult } from "./message-replay";
import { extractProviderError, type ProviderErrorSource } from "./provider-error";
import { publishSessionEvent, resetSessionEvents } from "./session-events";
import { buildFinalAssistantMessage } from "./stream-logic";
import { saveAssistantMessage } from "./stream-helpers";

export interface SessionEventTrackerOptions {
  sessionId: string;
  userId: string;
  session: AgentSession;
  /** Called once after the run settles and the `done` event has been published. */
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
  const { sessionId, userId, session } = options;

  const log = (tag: string, ...args: unknown[]) =>
    // eslint-disable-next-line no-console
    console.log(`[tracker:${sessionId}] ${tag}`, ...args);

  // ── Turn state ───────────────────────────────────────────────────────────
  let turnIndex = 0;
  let currentTurnId: string | null = null;
  // When the current assistant turn began. The row it becomes is written at
  // turn_end (after its tools ran), but its place in the conversation is here
  // — see `saveAssistantMessage`'s `createdAt`.
  let currentTurnStartedAt: Date | null = null;
  let currentTurnText = "";
  let currentTurnThinking = "";
  let rootMessageId: string | null = null;
  // Track the pending save promise from turn_end so agent_end can await it —
  // without this, agent_end runs before the .then() microtask sets
  // rootMessageId, causing a duplicate message create.
  let lastTurnSavePromise: Promise<{ id: string }> | null = null;
  // turnId of the most recent turn, needed to tell clients which bubble to drop
  // when the SDK discards a failed turn to retry it (see
  // `finalizeProvisionalTurn`), plus whether that turn produced anything the
  // user could have seen.
  let lastTurnId: string | null = null;
  let lastTurnHadOutput = false;

  // Tool call results tracking
  const toolCallResults = new Map<string, ToolCallResult>();

  // Throttle map for tool_execution_update forwarding — bash emits output
  // updates at ~100ms intervals; flooding the Redis buffer + SSE would be
  // wasteful. One forwarded update per tool call per second is plenty to
  // prove the run is alive and to show progress.
  const toolLastUpdateAt = new Map<string, number>();
  const TOOL_UPDATE_THROTTLE_MS = 1000;

  // Token usage tracking (billed totals, cumulative over the run)
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;

  // Guard: agent_end DB persistence runs once per run. Reset on agent_start
  // because a settled run can be followed by a continuation run (the SDK
  // re-enters the loop via agent.continue() after an error retry or an
  // overflow compact-and-retry), and each run finalizes its own last message.
  let agentEndPersisted = false;

  // Guard: settled bookkeeping runs exactly once per tracker.
  let settledFinalized = false;

  // Track all pending DB saves so "done" can wait for them
  const pendingSaves: Promise<unknown>[] = [];

  /** Start a new turn: generate a turnId and announce it on the bus. */
  const startTurn = (): string => {
    // The SDK's `turn_start` event records when the turn really began; the
    // fallback covers a turn whose start event was missed (a replay).
    currentTurnStartedAt ??= new Date();
    if (!currentTurnId) {
      currentTurnId = crypto.randomUUID();
      publishSessionEvent(sessionId, "turn_start", {
        turnId: currentTurnId,
        // Clients order the live turn by this, so a message delivered into
        // the run mid-turn sorts after it instead of above it.
        startedAt: currentTurnStartedAt.toISOString(),
      }).catch((err) => {
        console.error("Failed to publish turn_start:", err);
      });
    }
    return currentTurnId;
  };

  /**
   * State of a turn whose assistant message the SDK is about to discard.
   *
   * `session.prompt()` retries transient provider failures itself: on
   * `auto_retry_start` it removes the failed assistant message from its state
   * and re-runs the turn. That makes the attempt's row provisional — it is not
   * the run's outcome:
   *
   *  - It produced output the user already saw (a stream that died mid-answer,
   *    or a run the user stopped) → keep the row. Deleting it would erase text
   *    that was on screen a moment ago.
   *  - It produced nothing (the usual failure: the request was rejected before
   *    the first token) → remove it. Keeping it would leave one phantom bubble
   *    per attempt — three for a 429 that exhausts the retry budget — and the
   *    client would hold a `rootMessageId` pointing at a row that is gone.
   */
  const finalizeProvisionalTurn = () => {
    const turnId = lastTurnId;
    const hadOutput = lastTurnHadOutput;
    const hadTurnSave = lastTurnSavePromise !== null;
    const basePromise = lastTurnSavePromise ?? Promise.resolve(null);
    lastTurnSavePromise = null;
    lastTurnId = null;
    lastTurnHadOutput = false;
    currentTurnText = "";
    currentTurnThinking = "";

    if (hadOutput || !hadTurnSave) {
      // The row stays exactly as turn_end saved it (no error message: this
      // attempt is not the run's outcome, the retry is). Without a turn save
      // there is nothing to remove either.
      log("provisional", `kept turnId=${turnId}`);
      return;
    }

    // The turn is about to disappear, so it must not inflate the session's
    // message count at settle. Adjusted here, not in the delete chain below:
    // the count is read at agent_settled, which a fast retry could reach first.
    turnIndex = Math.max(0, turnIndex - 1);

    pendingSaves.push(
      basePromise
        .then(async (turnResult) => {
          const savedId = turnResult?.id ?? null;
          if (savedId) {
            await prisma.chatMessage.deleteMany({ where: { id: savedId, sessionId } });
            if (rootMessageId === savedId) rootMessageId = null;
          }
          await publishSessionEvent(sessionId, "turn_discarded", { turnId, messageId: savedId });
          log("discard", `turnId=${turnId}, msgId=${savedId ?? "none"}`);
        })
        .catch((err) => {
          console.error(`Failed to discard retried turn for ${sessionId}:`, err);
        }),
    );
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
  // it, and a long tool call that emits nothing would let the flag's short
  // liveness TTL expire mid-run — the 409 guard would stop blocking sends
  // while Pi is genuinely busy, and a watcher would take the session for dead.
  // While Pi streams, refresh the flag on a cadence well inside that TTL.
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
        agentEndPersisted = false;
        // Any stop request from before this run is stale — it must not be able
        // to swallow this run's real failures (see abort-request.ts).
        clearSessionAbort(userId, sessionId);
        // Reset the buffer first, then publish the send queue's current state:
        // a run can start from the queue (the drain claims a message before
        // prompting it) and clients move that message out of their queue strip
        // when this snapshot arrives. Publishing first would be discarded by
        // the reset.
        void resetSessionEvents(sessionId)
          .then(() => publishQueueUpdate(sessionId))
          .catch((err) => {
            console.error("Failed to reset session events:", err);
          });
        startActivityHeartbeat();
        break;
      }

      // ── Turn start: the assistant turn begins here, before its first
      //    token. Its row is only written at turn_end — stamping the row
      //    with the turn's start is what keeps the conversation in the order
      //    the turns actually happened in. ──
      case "turn_start": {
        currentTurnStartedAt = new Date();
        break;
      }

      // ── Token usage tracking ───────────────────────────────────────────────
      // NO auto-compaction here. Compaction is the SDK's job: it checks the
      // REAL context size (last message usage vs. contextWindow - reserve)
      // at run boundaries — before prompt submission and after agent_end —
      // and on overflow it compacts and continues the run. Calling
      // session.compact() mid-run would abort the in-flight run, and the
      // cumulative counter below only grows, so a threshold check here would
      // re-fire compact() on every subsequent message_end (double compaction).
      case "message_end": {
        if (event.message.role !== "assistant") break;

        const msg = event.message as unknown as Record<string, unknown>;
        const usage = msg.usage as Record<string, number> | undefined;
        if (!usage) break;

        totalInputTokens += usage.input ?? 0;
        totalOutputTokens += usage.output ?? 0;
        totalCacheReadTokens += usage.cacheRead ?? 0;
        totalCacheWriteTokens += usage.cacheWrite ?? 0;

        // Context size comes from Pi (see context-usage.ts) — NOT from the
        // counters above, which exclude cache reads and accumulate per turn.
        const context = readContextUsage(session);

        publishSessionEvent(sessionId, "token_usage", {
          input: totalInputTokens,
          output: totalOutputTokens,
          cacheRead: totalCacheReadTokens,
          cacheWrite: totalCacheWriteTokens,
          total:
            totalInputTokens + totalOutputTokens + totalCacheReadTokens + totalCacheWriteTokens,
          contextTokens: context.tokens,
          contextWindow: context.contextWindow,
        }).catch((err) => {
          console.error("Failed to publish token_usage:", err);
        });
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
        // No errorMessage here: a failed turn may still be retried by the SDK,
        // so whether this attempt is a reported failure is only known at
        // agent_end (see the willRetry branch).
        const turnSavePromise = saveAssistantMessage({
          sessionId,
          content: currentTurnText,
          thinking: currentTurnThinking || undefined,
          toolCalls: turnToolCalls.length > 0 ? turnToolCalls : undefined,
          parentMessageId: rootMessageId,
          createdAt: currentTurnStartedAt ?? undefined,
        });
        lastTurnSavePromise = turnSavePromise;
        lastTurnId = turnId;
        lastTurnHadOutput = Boolean(
          currentTurnText || currentTurnThinking || turnToolCalls.length > 0,
        );

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

      // ── Provider retry ──────────────────────────────────────────────────
      // `session.prompt()` retries transient provider failures (429/5xx/network)
      // itself, with exponential backoff. The backoff is dead air on the
      // stream, so clients are told why nothing is arriving.
      case "auto_retry_start": {
        publishSessionEvent(sessionId, "retry_start", {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          errorMessage: event.errorMessage,
        }).catch((err) => {
          console.error("Failed to publish retry_start:", err);
        });
        break;
      }

      case "auto_retry_end": {
        publishSessionEvent(sessionId, "retry_end", {
          success: event.success,
          attempt: event.attempt,
          finalError: event.finalError,
        }).catch((err) => {
          console.error("Failed to publish retry_end:", err);
        });
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
          // A manual compaction is started, and its summary persisted, by the
          // request that owns it (the /compact route). The tracker can still
          // be subscribed while that happens — a prompt run aborted by the
          // compaction settles after it began — and saving here as well would
          // put the same summary in the chat twice.
          if (event.reason !== "manual") {
            // Tracked as a pending save so `done` (emitted on agent_settled
            // after all saves settle) always lands after the summary is in
            // the DB — late /messages fetches can't miss it.
            pendingSaves.push(
              saveCompactionMessage({
                sessionId,
                summary: event.result.summary,
                tokensBefore: event.result.tokensBefore,
              }),
            );
          }

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

      // ── Agent run stopped — NOT necessarily finished ─────────────────────
      // Mirrors the TUI: agent_end only means the current loop iteration
      // ended. The SDK may still retry an error, run auto-compaction, or
      // continue the run (overflow recovery). So: finalize this run's last
      // message, but do NOT emit `done`, unregister, or dispose — that all
      // happens on agent_settled.
      case "agent_end": {
        log("agent_end", `totalMessages=${event.messages.length}, turnIndex=${turnIndex}`);

        // The SDK is about to retry this run's failed call (`willRetry` is
        // computed from the retry budget and whether the error is transient),
        // and retrying throws the assistant message away. This attempt is not
        // the outcome: keep what the user saw, drop an empty attempt, and
        // report nothing — a retry may still succeed, and an abort lands here
        // too (a cancelled request looks like any other stream failure).
        if (event.willRetry) {
          finalizeProvisionalTurn();
          break;
        }

        // A user-initiated stop is not a provider failure: Pi reports the
        // cancelled request as an error; Saale recorded the stop, so nothing is
        // reported. This matters when the stop lands on the terminal attempt —
        // with the retry budget spent (or retries disabled) there is no
        // `willRetry` to mark the attempt provisional.
        if (wasSessionAbortRequested(userId, sessionId)) {
          finalizeProvisionalTurn();
          break;
        }

        // Per-run guard: each run finalizes its own last assistant message
        // (reset in agent_start for continuation runs).
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
            const errorMessage = extractProviderError(lastAssistant as ProviderErrorSource);
            const turnId = currentTurnId ?? crypto.randomUUID();

            // Finalize: update existing message (multi-turn) or create new
            // (single-turn). Chain after turn_end save if still pending.
            const basePromise = lastTurnSavePromise ?? Promise.resolve(null);
            lastTurnSavePromise = null;

            pendingSaves.push(
              basePromise
                .then((turnResult) => {
                  const existingMessageId = turnResult?.id ?? rootMessageId ?? undefined;
                  return saveAssistantMessage({
                    sessionId,
                    content: text,
                    thinking: thinking || undefined,
                    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
                    messageId: existingMessageId,
                    errorMessage,
                    createdAt: currentTurnStartedAt ?? undefined,
                  }).then((msg) => ({ msg, existingMessageId }));
                })
                .then(({ msg, existingMessageId }) => {
                  log(
                    "db_save",
                    `agent_end ${existingMessageId ? "updated" : "created"} msgId=${msg.id}`,
                  );
                  if (!rootMessageId) {
                    rootMessageId = msg.id;
                  }
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
        }
        break;
      }

      // ── Agent settled: completely finished ───────────────────────────────
      // Emitted by the SDK after the run AND all post-run processing (error
      // retries, auto-compaction, queued continuations) are done. This is
      // the only safe moment to declare the generation finished: the
      // active-session flag, message count, `done` event, and tracker
      // disposal all happen here — never on agent_end.
      case "agent_settled": {
        log("agent_settled", `turns=${turnIndex}`);
        if (settledFinalized) break;
        settledFinalized = true;
        clearSessionAbort(userId, sessionId);

        // Unregister the active session and bump the message count once.
        // Assistant output is real chat activity — advance lastActivityAt
        // too (the UI's sort/display timestamp). Note: tool_execution_
        // start/end do NOT touch it, so tool calls alone never move a chat
        // to the top of the list.
        void Promise.all([
          unregisterActiveSession(userId, sessionId),
          prisma.chatSession.update({
            where: { id: sessionId },
            data: { messageCount: { increment: turnIndex || 1 }, lastActivityAt: new Date() },
          }),
        ]).catch((err) => {
          console.error("Failed to finalize session bookkeeping:", err);
        });

        // Wait for all DB saves (turn saves, agent_end finalization,
        // compaction messages) to complete before emitting "done".
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
