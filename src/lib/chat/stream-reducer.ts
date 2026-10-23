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
 *
 * The tag is client state, so a client that connects mid-run has none for the
 * turns saved before it arrived: a replayed event for one of those builds a
 * bubble until that turn's `message_saved` folds it into the row it was saved
 * as (see the `message_saved` case). That is one turn's worth of replayed
 * events, and the fold tags the row, so it cannot happen twice.
 */

export type StreamAction =
  | { type: "turn_start"; turnId: string; startedAt?: string }
  | { type: "token"; turnId: string; text: string }
  | { type: "thinking"; turnId: string; thinking: string }
  /**
   * The model announced a call and is still writing its arguments. Pi emits the
   * call in the assistant message it streams (`toolcall_start` / `toolcall_delta`)
   * long before execution (`tool_start`), so without this the transcript shows
   * nothing at all while the arguments are being filled in.
   */
  | {
      type: "tool_pending";
      turnId: string;
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
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
  /** `receivedAt` is the client clock when the event arrived (see `Message.savedAt`). */
  | { type: "message_saved"; turnId: string; messageId: string; receivedAt?: number }
  /** The SDK discarded a failed turn to retry it. drop the live bubble. */
  | { type: "turn_discarded"; turnId: string; messageId: string | null }
  /** Generation finished (done/error). drop live streaming turns. */
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
        // An empty event is the SDK's thinking block opening, not "stop
        // reasoning": clearing the field here would wipe the reasoning of a
        // turn whose row is already on screen and only a reload would bring it
        // back.
        messages: action.thinking
          ? ensureTurnMessage(state.messages, action.turnId, state.rootMessageId, {
              thinking: action.thinking,
            })
          : ensureTurnMessage(state.messages, action.turnId, state.rootMessageId),
      };

    case "tool_pending": {
      const existing = findTurnMessage(state.messages, action.turnId);
      if (!existing) {
        return {
          ...state,
          messages: ensureTurnMessage(state.messages, action.turnId, state.rootMessageId, {
            toolCalls: [buildPendingToolCall(action)],
          }),
        };
      }
      const known = existing.toolCalls?.find((tc) => tc.id === action.toolCallId);
      if (!known) {
        return {
          ...state,
          messages: state.messages.map((m) =>
            m === existing
              ? { ...m, toolCalls: [...(m.toolCalls || []), buildPendingToolCall(action)] }
              : m,
          ),
        };
      }
      // Already executing (or finished, after a replay): its arguments are the
      // authoritative ones and must not be overwritten by a later partial.
      if (known.status !== "pending") return state;
      return {
        ...state,
        messages: state.messages.map((m) =>
          m === existing
            ? {
                ...m,
                toolCalls: (m.toolCalls || []).map((tc) =>
                  tc.id === action.toolCallId ? { ...tc, args: action.args } : tc,
                ),
              }
            : m,
        ),
      };
    }

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
      const known = existing.toolCalls?.find((tc) => tc.id === action.toolCallId);
      if (known) {
        // The card is already on screen from `tool_pending`: execution starts,
        // so the badge flips and the arguments become the call's final ones.
        // Any other status means a re-delivered event (a replay); leave it.
        if (known.status !== "pending") return state;
        return {
          ...state,
          messages: state.messages.map((m) =>
            m === existing
              ? {
                  ...m,
                  toolCalls: (m.toolCalls || []).map((tc) =>
                    tc.id === action.toolCallId ? buildRunningToolCall(action) : tc,
                  ),
                }
              : m,
          ),
        };
      }
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
      // Nothing to swap: the turn is gone, or the row is already its message
      // (a re-delivered `message_saved`, e.g. from a replay).
      if (!turn || turn.id === action.messageId) return { ...state, rootMessageId };
      const row = state.messages.find((m) => m.id === action.messageId);
      if (row) {
        // The row is on screen already, so the server did not create one for
        // this turn: `agent_end` finalizes a run by updating an existing row,
        // and a reload can deliver that row while its turn still streams. Its
        // text and reasoning are the newest, so move them onto the row and drop
        // the bubble. dropping the content instead blanks the step until the
        // next reload, and keeping both duplicates the row.
        return {
          rootMessageId,
          messages: state.messages.flatMap((m) => {
            if (m === turn) return [];
            if (m !== row) return [m];
            return [
              {
                ...m,
                content: turn.content,
                thinking: turn.thinking,
                errorMessage: turn.errorMessage ?? m.errorMessage,
                // The row carries this turn now, so the turn's later events have
                // to find it. unless it is already identified by its own turn.
                turnId: m.turnId ?? turn.turnId,
              },
            ];
          }),
        };
      }
      return {
        rootMessageId,
        messages: state.messages.map((m) =>
          m === turn ? { ...m, id: action.messageId, savedAt: action.receivedAt ?? m.savedAt } : m,
        ),
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

/** A call the model has announced but not started yet: its arguments are still arriving. */
export function buildPendingToolCall(parsed: {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}): ToolCallData {
  return {
    id: parsed.toolCallId,
    name: parsed.toolName,
    args: parsed.args,
    status: "pending",
    result: undefined,
    error: undefined,
  };
}
