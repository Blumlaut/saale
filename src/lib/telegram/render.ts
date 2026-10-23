import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { resolveToolSummary } from "@/lib/pi/tool-summary-resolver";
import { extractCumulativeText } from "@/lib/pi/stream-logic";
import { sendTelegramMessage } from "./client";
import { sendSharedFileToTelegram, sharedFileFromToolCall } from "./files";

/**
 * Turns one agent run's events into the messages a phone sees.
 *
 * Both Telegram paths use it: the home thread (a bespoke Pi session) and a
 * message routed into an existing chat (a pooled one). What the phone shows
 * does not depend on which, so it lives here rather than in either runner.
 *
 * The renderer only reads the events it renders. Run control (settling,
 * retries, supersession) belongs to the runner that owns the session.
 */
export interface TelegramRunRenderer {
  /** Render one agent event. Control events are ignored. */
  onEvent(event: AgentSessionEvent): void;
  /** Deliver text no `turn_end` reported. Skipped for an interrupted run. */
  finish(interrupted: boolean): Promise<void>;
}

export function createTelegramRunRenderer(params: {
  userId: string;
  encryptedToken: string;
  telegramChatId: bigint;
  /** The user's message, when replies should thread under it. */
  replyToMessageId?: number | undefined;
}): TelegramRunRenderer {
  const { userId, encryptedToken, telegramChatId, replyToMessageId } = params;

  let turnIndex = 0;
  let currentTurnText = "";

  // Turns whose text already went out. Flushing happens in message_update when
  // a tool call appears, so text arrives before the approval request, not after
  // it at turn_end.
  const flushedTurnTexts = new Set<number>();
  const sentToolSummaries = new Set<string>();

  // Files the agent showed this turn, keyed by tool call. `tool_execution_end`
  // reports the result but not the arguments, so the path is captured when the
  // call starts.
  const sharedFiles = new Map<string, { filePath: string; description?: string }>();

  const replyOptions = (turn: number) =>
    turn === 0 && replyToMessageId != null ? { replyToMessageId } : undefined;

  /** Flush accumulated text to Telegram immediately. */
  function flushTurnText(turn: number): void {
    if (!currentTurnText.trim()) return;
    if (flushedTurnTexts.has(turn)) return;
    flushedTurnTexts.add(turn);

    sendTelegramMessage(encryptedToken, telegramChatId, currentTurnText, replyOptions(turn)).catch(
      (err) => {
        console.error("Failed to send Telegram message for turn:", err);
      },
    );
  }

  return {
    onEvent(event) {
      switch (event.type) {
        case "message_update": {
          if (event.message.role !== "assistant") return;
          const msg = event.message as { content: unknown[] };
          currentTurnText = extractCumulativeText(msg.content);

          // Flush NOW when a tool call appears. the approval request fires
          // inside tool.execute() (before tool_execution_start), so the agent's
          // text has to arrive before the card.
          const hasToolCall = msg.content.some(
            (c) =>
              typeof c === "object" &&
              c !== null &&
              (c as Record<string, unknown>).type === "toolCall",
          );
          if (hasToolCall) flushTurnText(turnIndex);
          break;
        }

        case "tool_execution_start": {
          const sharedFile = sharedFileFromToolCall(event.toolName, event.args);
          if (sharedFile) sharedFiles.set(event.toolCallId, sharedFile);

          if (!sentToolSummaries.has(event.toolCallId)) {
            sentToolSummaries.add(event.toolCallId);

            resolveToolSummary(event.toolName, event.args, userId)
              .then((summary) => {
                if (!summary) return;
                return sendTelegramMessage(
                  encryptedToken,
                  telegramChatId,
                  `🔧 \`${summary}\``,
                ).catch((err) => {
                  console.error("Failed to send Telegram tool summary:", err);
                });
              })
              .catch((err) => {
                console.error("Failed to resolve tool summary:", err);
              });
          }
          break;
        }

        case "tool_execution_end": {
          // A file the agent showed follows the answer to the phone. the tool's
          // own result carries no bytes, so it is read back from the workspace.
          const sharedFile = sharedFiles.get(event.toolCallId);
          if (sharedFile) {
            sharedFiles.delete(event.toolCallId);

            if (!event.isError) {
              sendSharedFileToTelegram({
                userId,
                encryptedToken,
                telegramChatId,
                ...sharedFile,
              }).catch((err) => {
                console.error("Failed to send a shared file to Telegram:", err);
              });
            }
          }
          break;
        }

        case "turn_end": {
          const assistantMsg =
            event.message.role === "assistant" ? (event.message as { content: unknown[] }) : null;

          const text = assistantMsg ? extractCumulativeText(assistantMsg.content) : currentTurnText;

          if (text.trim() && !flushedTurnTexts.has(turnIndex)) {
            sendTelegramMessage(
              encryptedToken,
              telegramChatId,
              text,
              replyOptions(turnIndex),
            ).catch((err) => {
              console.error("Failed to send Telegram message for turn:", err);
            });
          }

          turnIndex++;
          currentTurnText = "";
          break;
        }

        case "compaction_start": {
          sendTelegramMessage(
            encryptedToken,
            telegramChatId,
            "\U0001f504 Compacting conversation...",
          ).catch((err) => {
            console.error("Failed to send Telegram compaction start message:", err);
          });
          break;
        }

        case "compaction_end": {
          // The summary itself is persisted by the session event tracker.
          if (event.result && !event.aborted) {
            const tokensAfter = event.result.estimatedTokensAfter;
            const tokensInfo = tokensAfter
              ? ` (was ${event.result.tokensBefore.toLocaleString()} tokens, now ~${tokensAfter.toLocaleString()})`
              : ` (was ${event.result.tokensBefore.toLocaleString()} tokens)`;
            sendTelegramMessage(
              encryptedToken,
              telegramChatId,
              `\u2705 Compaction complete${tokensInfo}.`,
            ).catch((err) => {
              console.error("Failed to send Telegram compaction end message:", err);
            });
          }
          break;
        }
      }
    },

    async finish(interrupted) {
      // For single-turn responses (no turn_end fired), make sure the text is
      // still delivered. Interrupted runs are superseded by the new message's
      // reply. a stale partial answer would only confuse the user.
      if (interrupted) return;
      if (turnIndex !== 0 || !currentTurnText.trim() || flushedTurnTexts.has(0)) return;

      await sendTelegramMessage(
        encryptedToken,
        telegramChatId,
        currentTurnText,
        replyOptions(0),
      ).catch((err) => {
        console.error("Failed to send the Telegram reply:", err);
      });
    },
  };
}
