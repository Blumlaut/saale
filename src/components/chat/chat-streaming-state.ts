import type { Dispatch, SetStateAction } from "react";
import type { Message, ToolCallData } from "./types";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TurnData {
  text: string;
  thinking: string;
  toolCalls: Array<{
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    status: "running" | "completed" | "error";
    result: string | undefined;
    error: string | undefined;
  }>;
}

export interface StreamingState {
  turns: TurnData[];
  current: TurnData;
  /** Animated text shown to the user — lags behind current.text and catches up via rAF */
  displayText: string;
  /** Animated thinking shown to the user — lags behind current.thinking */
  displayThinking: string;
}

export interface ApprovalRequest {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  expiresAt: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export const emptyTurn = (): TurnData => ({
  text: "",
  thinking: "",
  toolCalls: [],
});

export const EMPTY_DISPLAY = {
  displayText: "",
  displayThinking: "",
} as const;

function convertToolCalls(turns: TurnData["toolCalls"]): ToolCallData[] {
  return turns.map((tc) => ({
    id: tc.toolCallId,
    name: tc.toolName,
    args: tc.args,
    error: tc.error,
    status: tc.status,
    result: tc.result,
  }));
}

/** Collect all turns from streaming state (completed + current if non-empty) */
export function collectAllTurns(state: StreamingState): TurnData[] {
  return [
    ...state.turns,
    ...(state.current.text || state.current.thinking || state.current.toolCalls.length > 0
      ? [{ ...state.current }]
      : []),
  ];
}

/** Build a display message from a single turn */
export function buildTurnMessage(
  turn: TurnData,
  id: string,
  parentMessageId: string | undefined,
): Message {
  return {
    id,
    role: "assistant",
    content: turn.text,
    thinking: turn.thinking || undefined,
    toolCalls:
      turn.toolCalls.length > 0
        ? turn.toolCalls.map((tc) => ({
            id: tc.toolCallId,
            name: tc.toolName,
            args: tc.args,
            error: tc.error,
            status: tc.status,
            result: tc.result || undefined,
          }))
        : undefined,
    createdAt: new Date().toISOString(),
    parentMessageId,
    attachments: undefined,
  };
}

/** Build assistant messages from a list of turns */
function buildAssistantMessages(turns: TurnData[], prefix: string): Message[] {
  return turns.map((turn, index) => ({
    id: `${prefix}-${index}`,
    role: "assistant" as const,
    content: turn.text,
    thinking: turn.thinking || undefined,
    toolCalls: turn.toolCalls.length > 0 ? convertToolCalls(turn.toolCalls) : undefined,
    parentMessageId: index > 0 ? `${prefix}-0` : undefined,
    createdAt: new Date().toISOString(),
    attachments: undefined,
  }));
}

/**
 * Finalize streaming state by adding all turns as messages.
 *
 * This is the safety net — it ensures streamed content is NEVER lost.
 * Called on done/error/connection-error to persist streamed turns into the messages array.
 */
export function finalizeStreaming(
  streamingState: StreamingState,
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
) {
  const allTurns = collectAllTurns(streamingState);
  if (allTurns.length > 0) {
    const baseId = `assistant-turn-${Date.now()}`;
    setMessages((prev) => [...prev, ...buildAssistantMessages(allTurns, baseId)]);
  }
}

/**
 * Load messages from DB, but only replace if we actually got new assistant messages.
 * This prevents the "flash of blank" when DB hasn't saved yet.
 *
 * @param messageCountBefore  Number of assistant messages before streaming started.
 * @returns true if messages were successfully loaded from DB.
 */
export async function tryLoadFromDb(
  sessionId: string,
  messageCountBefore: number,
  setMessages: Dispatch<SetStateAction<Message[]>>,
): Promise<boolean> {
  try {
    const res = await fetch(`/api/chat/sessions/${sessionId}/messages`);
    if (!res.ok) return false;
    const data = await res.json();
    const assistantCount = (data.messages || []).filter(
      (m: { role: string }) => m.role === "assistant",
    ).length;
    // Only replace if DB has more assistant messages than before streaming
    if (assistantCount > messageCountBefore) {
      setMessages(data.messages);
      return true;
    }
    return false;
  } catch (err) {
    console.error("Failed to load messages from DB:", err);
    return false;
  }
}
