import { useCallback, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Message, ApprovalData } from "./types";
import type { TokenUsage } from "./input-bar";
import type { StreamingState } from "./chat-streaming-state";
import { emptyTurn, EMPTY_DISPLAY, finalizeStreaming, tryLoadFromDb } from "./chat-streaming-state";
import { setupStreamListeners } from "./chat-stream-listeners";

/**
 * Shared SSE stream orchestration for chat.
 *
 * All stream paths (send, edit, reconnect) share the same pattern:
 *  1. Reset streaming state
 *  2. Open EventSource
 *  3. Wire up common listeners via setupStreamListeners
 *  4. On done/error: finalize streaming + cleanup
 *
 * Reconnection uses the SSE spec's Last-Event-ID mechanism:
 * - Server buffers all events with monotonic IDs in Redis
 * - On reconnect, server replays buffered events from the last known ID
 * - If no lastEventId is available (page refresh), server replays the full buffer
 *   when the agent is already processing
 *
 * This hook centralizes that pattern so the main component stays lean.
 */
export function useChatStream(
  sessionId: string,
  streamingRef: React.RefObject<StreamingState>,
  eventSourceRef: React.RefObject<EventSource | null>,
  setStreaming: Dispatch<SetStateAction<StreamingState>>,
  setMessages: Dispatch<SetStateAction<Message[]>>,
  setIsLoading: Dispatch<SetStateAction<boolean>>,
  setPendingApprovals: Dispatch<SetStateAction<ApprovalData[]>>,
  markDone: (id: string) => void,
  onTokenUsage?: (usage: TokenUsage) => void,
  onCompactionStart?: () => void,
  onCompactionEnd?: (summary?: string, tokensBefore?: number) => void,
) {
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track the last SSE event ID for reconnection.
  // We extract this from MessageEvent.lastEventId since the server sends
  // `id:` fields with every event.
  const lastEventIdRef = useRef("");

  /**
   * Reset streaming state to empty. Called before opening a new stream.
   */
  const resetStreaming = useCallback(() => {
    const initState = { turns: [], current: emptyTurn(), ...EMPTY_DISPLAY };
    setStreaming(initState);
    streamingRef.current = initState;
  }, [setStreaming, streamingRef]);

  /**
   * Close the current EventSource and clear refs.
   */
  const closeEventSource = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, [eventSourceRef]);

  /**
   * Wire up approval request handler (shared across all stream paths).
   */
  const handleApprovalRequest = useCallback(
    (request: ApprovalData) => {
      setPendingApprovals((prev) => {
        if (prev.some((a) => a.toolCallId === request.toolCallId)) return prev;
        return [...prev, request];
      });
    },
    [setPendingApprovals],
  );

  /**
   * Start reconnection via SSE. Used when user refreshes during generation
   * or gets a 409 (already processing).
   *
   * The server replays buffered events from Redis and subscribes to live
   * agent events. No separate Redis pub/sub path needed.
   */
  const startReconnection = useCallback(
    (onLoadMessages: () => Promise<unknown>, _onLoadSessionTitle: () => Promise<unknown>) => {
      closeEventSource();
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }

      setIsLoading(true);
      resetStreaming();

      // Pass lastEventId if we have one (from a previous connection in this session).
      // On page refresh, this will be empty — the server handles this by replaying
      // the full buffer when the agent is already processing.
      const reconnectUrl = lastEventIdRef.current
        ? `/api/chat/sessions/${sessionId}/stream?lastEventId=${lastEventIdRef.current}`
        : `/api/chat/sessions/${sessionId}/stream`;

      const eventSource = new EventSource(reconnectUrl);
      eventSourceRef.current = eventSource;

      const cleanup = () => {
        eventSource.close();
        eventSourceRef.current = null;
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
      };

      setupStreamListeners(eventSource, setStreaming, streamingRef, {
        onDone: () => {
          cleanup();
          finalizeStreaming(streamingRef.current, setMessages);
          setIsLoading(false);
          void onLoadMessages();
          markDone(sessionId);
        },
        onError: () => {
          cleanup();
          finalizeStreaming(streamingRef.current, setMessages);
          setIsLoading(false);
          markDone(sessionId);
        },
        onConnectionError: () => {
          cleanup();
          finalizeStreaming(streamingRef.current, setMessages);
          setIsLoading(false);
          markDone(sessionId);
        },
        onApprovalRequest: handleApprovalRequest,
        ...(onTokenUsage ? { onTokenUsage } : {}),
        ...(onCompactionStart ? { onCompactionStart } : {}),
        ...(onCompactionEnd ? { onCompactionEnd } : {}),
      });

      // Safety timeout — if still loading after 30s, force-clear and reload from DB.
      // This handles edge cases where the buffer is stale or the agent crashed.
      reconnectTimerRef.current = setTimeout(() => {
        cleanup();
        finalizeStreaming(streamingRef.current, setMessages);
        setIsLoading(false);
        void onLoadMessages();
        markDone(sessionId);
      }, 30_000);
    },
    [
      sessionId,
      closeEventSource,
      resetStreaming,
      setIsLoading,
      setStreaming,
      streamingRef,
      eventSourceRef,
      setMessages,
      markDone,
      handleApprovalRequest,
      onTokenUsage,
      onCompactionStart,
      onCompactionEnd,
    ],
  );

  /**
   * Connect to a stream URL and wire up listeners.
   * Returns the EventSource so the caller can close it on error.
   */
  const connectStream = useCallback(
    (streamUrl: string, assistantCountBefore: number): EventSource => {
      resetStreaming();

      const eventSource = new EventSource(streamUrl);
      eventSourceRef.current = eventSource;

      // Track last event ID for potential reconnection.
      // Extract from MessageEvent.lastEventId — the server sends `id:` fields.
      const trackEventId = (e: MessageEvent) => {
        if (e.lastEventId) {
          lastEventIdRef.current = e.lastEventId;
        }
      };
      eventSource.addEventListener("message", trackEventId);
      for (const type of [
        "token",
        "thinking",
        "tool_start",
        "tool_end",
        "turn_end",
        "done",
        "error",
      ] as const) {
        eventSource.addEventListener(type, trackEventId);
      }

      const cleanup = () => {
        eventSource.close();
        eventSourceRef.current = null;
      };

      setupStreamListeners(eventSource, setStreaming, streamingRef, {
        onDone: () => {
          cleanup();
          finalizeStreaming(streamingRef.current, setMessages);
          setIsLoading(false);
          void tryLoadFromDb(sessionId, assistantCountBefore, setMessages);
        },
        onError: () => {
          cleanup();
          finalizeStreaming(streamingRef.current, setMessages);
          setIsLoading(false);
        },
        onConnectionError: () => {
          cleanup();
          finalizeStreaming(streamingRef.current, setMessages);
          setIsLoading(false);
        },
        onApprovalRequest: handleApprovalRequest,
        ...(onTokenUsage ? { onTokenUsage } : {}),
        ...(onCompactionStart ? { onCompactionStart } : {}),
        ...(onCompactionEnd ? { onCompactionEnd } : {}),
      });

      return eventSource;
    },
    [
      sessionId,
      resetStreaming,
      setStreaming,
      streamingRef,
      eventSourceRef,
      setMessages,
      setIsLoading,
      handleApprovalRequest,
      onTokenUsage,
      onCompactionStart,
      onCompactionEnd,
    ],
  );

  return {
    startReconnection,
    connectStream,
    closeEventSource,
    resetStreaming,
    reconnectTimerRef,
  };
}
