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
 */

export type StreamAction =
  | { type: "turn_start"; turnId: string }
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
  const id = `streaming-${turnId}`;
  if (messages.some((m) => m.id === id)) {
    return messages.map((m) => (m.id === id ? { ...m, ...patch } : m));
  }
  return [...messages, makeStreamingMessage(turnId, rootMessageId ?? undefined, patch)];
}

export function streamReducer(state: StreamState, action: StreamAction): StreamState {
  switch (action.type) {
    case "turn_start":
      return {
        ...state,
        messages: ensureTurnMessage(state.messages, action.turnId, state.rootMessageId),
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
      const id = `streaming-${action.turnId}`;
      const existing = state.messages.find((m) => m.id === id);
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
          m.id === id
            ? { ...m, toolCalls: [...(m.toolCalls || []), buildRunningToolCall(action)] }
            : m,
        ),
      };
    }

    case "tool_update":
      return {
        ...state,
        messages: state.messages.map((m) => {
          if (m.id !== `streaming-${action.turnId}` || !m.toolCalls) return m;
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

    case "tool_end":
      return {
        ...state,
        messages: state.messages.map((m) => {
          if (m.id !== `streaming-${action.turnId}` || !m.toolCalls) return m;
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
      // Match on both ids: the turn may still be streaming, or may already
      // have been swapped for its (now deleted) DB row by `message_saved`.
      const rootMessageId =
        state.rootMessageId && state.rootMessageId === action.messageId
          ? null
          : state.rootMessageId;
      return {
        rootMessageId,
        messages: state.messages.filter(
          (m) =>
            m.id !== `streaming-${action.turnId}` &&
            (action.messageId === null || m.id !== action.messageId),
        ),
      };
    }

    case "message_saved": {
      // First saved message of a generation is the root (parent of later turns).
      const rootMessageId = state.rootMessageId ?? action.messageId;
      return {
        rootMessageId,
        messages: state.messages.map((m) =>
          m.id === `streaming-${action.turnId}` ? { ...m, id: action.messageId } : m,
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
