import type { Message, ToolCallData } from "@/components/chat/types";
import { isStreamingMessage, makeStreamingMessage } from "./message-factories";

/**
 * Pure state machine for chat SSE stream events.
 *
 * Every message-state transition triggered by a stream event lives here as a
 * pure function, so the streaming logic (turn creation, tool-call dedupe,
 * temp-ID swaps, parent grouping) is unit-testable without React or a
 * connection. The `use-chat-stream` wiring only parses JSON and glues the
 * result into `setMessages`.
 *
 * Events are ordered by the server (and by the buffer replay), so the reducer
 * is applied sequentially. All events are idempotent where it matters:
 * re-delivered tool calls and cumulative token text never double-apply.
 *
 * A turn's message is identified by its `turnId`, not by the `streaming-{turnId}`
 * id: `message_saved` renames the bubble to its DB row, and the buffer replay
 * (and a mid-run reload) can deliver that turn's events again afterwards. Id
 * matching alone would treat the renamed row as "this turn is new" and add a
 * second copy of a step the user is already looking at.
 */

export type StreamAction =
  | { type: "turn_start"; turnId: string; startedAt?: string }
  | { type: "token"; turnId: string; text: string }
  | { type: "thinking"; turnId: string; thinking: string }
  | {
      type: "tool_start";
      turnId: string;
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | { type: "tool_update"; turnId: string; toolCallId: string; partialResult?: string }
  | { type: "tool_end"; turnId: string; toolCallId: string; result?: string; isError?: boolean }
  | { type: "turn_end"; turnId: string; text?: string; thinking?: string | null }
  | { type: "message_saved"; turnId: string; messageId: string }
  /** The SDK discarded a failed turn to retry it — drop the live bubble. */
  | { type: "turn_discarded"; turnId: string; messageId: string | null }
  /** Generation finished (done/error) — drop live streaming turns. */
  | { type: "generation_done" };

export interface StreamState {
  messages: Message[];
  /**
   * ID of the first saved message of the current generation. Later turns of
   * the same generation use it as `parentMessageId` so multi-turn runs group
   * into a single bubble. Reset on connect and after `generation_done`.
   */
  rootMessageId: string | null;
}

/**
 * The message a turn's stream events belong to, streaming or already saved.
 */
function findTurnMessage(messages: Message[], turnId: string): Message | undefined {
  return (
    messages.find((m) => m.turnId === turnId) ??
    messages.find((m) => m.id === `streaming-${turnId}`)
  );
}

/**
 * Ensure a streaming message exists for a turnId, optionally patching it.
 * Replaying events may arrive without the preceding `turn_start` (e.g. when
 * the buffer was trimmed), so every event can create the message.
 */
function ensureTurnMessage(
  messages: Message[],
  turnId: string,
  rootMessageId: string | null,
  patch?: Partial<Message>,
): Message[] {
  const existing = findTurnMessage(messages, turnId);
  if (existing) {
    return messages.map((m) => (m === existing ? { ...m, ...patch } : m));
  }
  return [...messages, makeStreamingMessage(turnId, rootMessageId ?? undefined, patch)];
}

export function streamReducer(state: StreamState, action: StreamAction): StreamState {
  switch (action.type) {
    case "turn_start":
      return {
        ...state,
        messages: ensureTurnMessage(state.messages, action.turnId, state.rootMessageId, {
          // The server's turn start is the live bubble's conversation
          // position, so a message delivered into the turn mid-run (a
          // steered "send now") sorts after it. Without it the bubble is
          // ordered by the browser clock, which the merge cannot trust.
          ...(action.startedAt ? { createdAt: action.startedAt } : {}),
        }),
      };

    case "token":
      return {
        ...state,
        messages: ensureTurnMessage(state.messages, action.turnId, state.rootMessageId, {
          content: action.text,
        }),
      };

    case "thinking":
      return {
        ...state,
        messages: ensureTurnMessage(state.messages, action.turnId, state.rootMessageId, {
          thinking: action.thinking || undefined,
        }),
      };

    case "tool_start": {
      const existing = findTurnMessage(state.messages, action.turnId);
      if (!existing) {
        return {
          ...state,
          messages: ensureTurnMessage(state.messages, action.turnId, state.rootMessageId, {
            toolCalls: [buildRunningToolCall(action)],
          }),
        };
      }
      // Dedupe — the same tool call may be re-delivered on reconnect.
      if (existing.toolCalls?.some((tc) => tc.id === action.toolCallId)) return state;
      return {
        ...state,
        messages: state.messages.map((m) =>
          m === existing
            ? { ...m, toolCalls: [...(m.toolCalls || []), buildRunningToolCall(action)] }
            : m,
        ),
      };
    }

    case "tool_update": {
      const target = findTurnMessage(state.messages, action.turnId);
      if (!target?.toolCalls) return state;
      return {
        ...state,
        messages: state.messages.map((m) => {
          if (m !== target || !m.toolCalls) return m;
          return {
            ...m,
            toolCalls: m.toolCalls.map((tc) =>
              tc.id === action.toolCallId && tc.status === "running"
                ? { ...tc, result: action.partialResult ?? undefined }
                : tc,
            ),
          };
        }),
      };
    }

    case "tool_end": {
      const target = findTurnMessage(state.messages, action.turnId);
      if (!target?.toolCalls) return state;
      return {
        ...state,
        messages: state.messages.map((m) => {
          if (m !== target || !m.toolCalls) return m;
          return {
            ...m,
            toolCalls: m.toolCalls.map((tc) =>
              tc.id === action.toolCallId
                ? {
                    ...tc,
                    status: action.isError ? ("error" as const) : ("completed" as const),
                    result: action.result ?? undefined,
                    error: action.isError ? (action.result ?? undefined) : undefined,
                  }
                : tc,
            ),
          };
        }),
      };
    }

    case "turn_end":
      return {
        ...state,
        messages: ensureTurnMessage(state.messages, action.turnId, state.rootMessageId, {
          ...(action.text ? { content: action.text } : {}),
          ...(action.thinking ? { thinking: action.thinking } : {}),
        }),
      };

    case "turn_discarded": {
      // The retry re-runs the turn, so the bubble goes; `rootMessageId` must
      // be cleared when it pointed at the discarded message, otherwise the
      // retried turn would be grouped as a child of a nonexistent parent.
      // Match the turn, not just its id: the bubble may still be streaming, or
      // may already have been swapped for its (now deleted) DB row.
      const discarded = findTurnMessage(state.messages, action.turnId);
      const rootMessageId =
        state.rootMessageId &&
        (state.rootMessageId === action.messageId || state.rootMessageId === discarded?.id)
          ? null
          : state.rootMessageId;
      return {
        rootMessageId,
        messages: state.messages.filter(
          (m) => m !== discarded && (action.messageId === null || m.id !== action.messageId),
        ),
      };
    }

    case "message_saved": {
      // First saved message of a generation is the root (parent of later turns).
      const rootMessageId = state.rootMessageId ?? action.messageId;
      const turn = findTurnMessage(state.messages, action.turnId);
      // Nothing to swap: the turn is gone, or the row is already the turn's
      // message (a re-delivered `message_saved`, e.g. from a replay).
      if (!turn || turn.id === action.messageId) return { ...state, rootMessageId };
      // The row is on screen already (loaded, or replayed) — the live bubble
      // would be a second copy of the same message under the same id.
      if (state.messages.some((m) => m.id === action.messageId)) {
        return { ...state, rootMessageId, messages: state.messages.filter((m) => m !== turn) };
      }
      return {
        rootMessageId,
        messages: state.messages.map((m) => (m === turn ? { ...m, id: action.messageId } : m)),
      };
    }

    case "generation_done":
      return { ...state, messages: state.messages.filter((m) => !isStreamingMessage(m)) };
  }
}

export function buildRunningToolCall(parsed: {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}): ToolCallData {
  return {
    id: parsed.toolCallId,
    name: parsed.toolName,
    args: parsed.args,
    status: "running",
    result: undefined,
    error: undefined,
  };
}
