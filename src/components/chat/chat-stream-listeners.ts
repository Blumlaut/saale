import type { Dispatch, SetStateAction } from "react";
import type { StreamingState } from "./chat-streaming-state";
import type { ToolCallData, ApprovalData } from "./types";
import type { TokenUsage } from "./input-bar";
import { emptyTurn } from "./chat-streaming-state";

/** Callbacks for SSE stream events */
export interface StreamCallbacks {
  onDone: (eventSource: EventSource, event: MessageEvent) => void;
  onError: (eventSource: EventSource, event: MessageEvent) => void;
  onConnectionError: (eventSource: EventSource) => void;
  onApprovalRequest?: (request: ApprovalData) => void;
  onTokenUsage?: (usage: TokenUsage) => void;
  onCompactionStart?: () => void;
  onCompactionEnd?: () => void;
}

/**
 * Set up common SSE event listeners for streaming.
 *
 * CRITICAL: updates streamingRef synchronously alongside setStreaming.
 * This ensures streamingRef is NEVER stale when done/error fires.
 *
 * Handles: token, thinking, tool_start, tool_end, turn_end
 *
 * @returns cleanup function that closes the EventSource
 */
export function setupStreamListeners(
  eventSource: EventSource,
  setStreaming: Dispatch<SetStateAction<StreamingState>>,
  streamingRef: React.RefObject<StreamingState>,
  callbacks: StreamCallbacks,
): () => void {
  eventSource.addEventListener("token", (event: MessageEvent) => {
    const parsed = JSON.parse(event.data) as { text: string };
    setStreaming((prev) => {
      const next = {
        ...prev,
        current: { ...prev.current, text: parsed.text },
      };
      streamingRef.current = next;
      return next;
    });
  });

  eventSource.addEventListener("thinking", (event: MessageEvent) => {
    const parsed = JSON.parse(event.data) as { thinking: string };
    setStreaming((prev) => {
      const next = {
        ...prev,
        current: { ...prev.current, thinking: parsed.thinking },
      };
      streamingRef.current = next;
      return next;
    });
  });

  eventSource.addEventListener("tool_start", (event: MessageEvent) => {
    const parsed = JSON.parse(event.data) as {
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    };
    setStreaming((prev) => {
      const next = {
        ...prev,
        current: {
          ...prev.current,
          toolCalls: [
            ...prev.current.toolCalls,
            {
              toolCallId: parsed.toolCallId,
              toolName: parsed.toolName,
              args: parsed.args,
              status: "running" as const,
              result: undefined,
              error: undefined,
            },
          ],
        },
      };
      streamingRef.current = next;
      return next;
    });
  });

  eventSource.addEventListener("tool_end", (event: MessageEvent) => {
    const parsed = JSON.parse(event.data) as {
      toolCallId: string;
      result?: string;
      isError?: boolean;
    };
    setStreaming((prev) => {
      const next = {
        ...prev,
        current: {
          ...prev.current,
          toolCalls: prev.current.toolCalls.map((tc) =>
            tc.toolCallId === parsed.toolCallId
              ? {
                  ...tc,
                  status: parsed.isError ? ("error" as const) : ("completed" as const),
                  result: parsed.result ?? undefined,
                  error: parsed.isError ? (parsed.result ?? undefined) : undefined,
                }
              : tc,
          ),
        },
      };
      streamingRef.current = next;
      return next;
    });
  });

  eventSource.addEventListener("turn_end", (event: MessageEvent) => {
    const parsed = JSON.parse(event.data) as {
      text?: string;
      thinking?: string;
      toolCalls?: ToolCallData[];
    };
    const toolCalls =
      parsed.toolCalls && parsed.toolCalls.length > 0
        ? parsed.toolCalls.map((tc: ToolCallData) => ({
            toolCallId: tc.id,
            toolName: tc.name,
            args: tc.args,
            status: tc.error ? ("error" as const) : ("completed" as const),
            result: tc.result ?? undefined,
            error: tc.error ?? undefined,
          }))
        : [];
    setStreaming((prev) => {
      const next = {
        ...prev,
        turns: [
          ...prev.turns,
          {
            text: parsed.text || prev.current.text,
            thinking: parsed.thinking || prev.current.thinking,
            toolCalls: toolCalls.length > 0 ? toolCalls : prev.current.toolCalls,
          },
        ],
        current: emptyTurn(),
      };
      streamingRef.current = next;
      return next;
    });
  });

  if (callbacks.onApprovalRequest) {
    eventSource.addEventListener("tool_approval_request", (event: MessageEvent) => {
      const parsed = JSON.parse(event.data) as ApprovalData;
      callbacks.onApprovalRequest!(parsed);
    });
  }

  if (callbacks.onTokenUsage) {
    eventSource.addEventListener("token_usage", (event: MessageEvent) => {
      const parsed = JSON.parse(event.data) as TokenUsage;
      callbacks.onTokenUsage!(parsed);
    });
  }

  if (callbacks.onCompactionStart) {
    eventSource.addEventListener("compaction_start", () => {
      callbacks.onCompactionStart!();
    });
  }

  if (callbacks.onCompactionEnd) {
    eventSource.addEventListener("compaction_end", () => {
      callbacks.onCompactionEnd!();
    });
  }

  eventSource.addEventListener("done", (event: MessageEvent) => {
    callbacks.onDone(eventSource, event);
  });

  eventSource.addEventListener("error", (event: MessageEvent) => {
    const parsed = JSON.parse(event.data);
    console.error("Stream error:", parsed);
    callbacks.onError(eventSource, event);
  });

  eventSource.onerror = () => {
    callbacks.onConnectionError(eventSource);
  };

  return () => {
    eventSource.close();
  };
}
