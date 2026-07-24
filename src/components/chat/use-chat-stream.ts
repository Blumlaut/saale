import { useCallback, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Message } from "./types";
import type { StreamingState, ApprovalRequest } from "./chat-streaming-state";
import { emptyTurn, EMPTY_DISPLAY, finalizeStreaming, tryLoadFromDb } from "./chat-streaming-state";
import { setupStreamListeners } from "./chat-stream-listeners";

/**
 * Shared SSE stream orchestration for chat.
 *
 * All three stream paths (send, edit, reconnect) share the same pattern:
 *  1. Reset streaming state
 *  2. Open EventSource
 *  3. Wire up common listeners via setupStreamListeners
 *  4. On done/error: finalize streaming + cleanup
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
  setPendingApprovals: Dispatch<SetStateAction<ApprovalRequest[]>>,
  markDone: (id: string) => void,
) {
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    (request: ApprovalRequest) => {
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
   * The stream endpoint subscribes to Redis pub/sub and forwards live events.
   */
  const startReconnection = useCallback(
    (onLoadMessages: () => Promise<unknown>, _onLoadSessionTitle: () => Promise<unknown>) => {
      closeEventSource();
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }

      setIsLoading(true);
      resetStreaming();

      const eventSource = new EventSource(`/api/chat/sessions/${sessionId}/stream?reconnect=1`);
      eventSourceRef.current = eventSource;

      let dbPollInterval: ReturnType<typeof setInterval> | null = null;

      const cleanup = () => {
        eventSource.close();
        eventSourceRef.current = null;
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
        if (dbPollInterval) {
          clearInterval(dbPollInterval);
          dbPollInterval = null;
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
      });

      // Resume event: backend DB polling detected generation is done.
      eventSource.addEventListener("resume", () => {
        cleanup();
        setIsLoading(false);
        void onLoadMessages();
        markDone(sessionId);
      });

      // Tool resume: backend detected an in-progress tool (persisted to DB).
      eventSource.addEventListener("tool_resume", (event: MessageEvent) => {
        const parsed = JSON.parse(event.data) as {
          toolCallId: string;
          toolName: string;
          args: Record<string, unknown>;
          startedAt: string | null;
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
                  args: parsed.args ?? {},
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
        // Reset safety timeout since we know the agent is still working
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
      });

      // Safety timeout — if still loading after 15s, force-clear and reload from DB.
      reconnectTimerRef.current = setTimeout(() => {
        cleanup();
        finalizeStreaming(streamingRef.current, setMessages);
        setIsLoading(false);
        void onLoadMessages();
        markDone(sessionId);
      }, 15_000);

      // Fallback: poll the DB during reconnection.
      let dbPollDone = false;
      const markDbPollDone = () => {
        dbPollDone = true;
      };
      for (const type of ["done", "error", "resume"] as const) {
        eventSource.addEventListener(type, markDbPollDone);
      }

      dbPollInterval = setInterval(async () => {
        if (dbPollDone) {
          clearInterval(dbPollInterval!);
          dbPollInterval = null;
          return;
        }
        try {
          const res = await fetch(`/api/chat/sessions/${sessionId}/messages`);
          if (!res.ok) return;
          const data = await res.json();
          if (!data.session?.processingSince) {
            const assistantMessages = data.messages?.filter(
              (m: { role: string }) => m.role === "assistant",
            );
            if (assistantMessages && assistantMessages.length > 0) {
              cleanup();
              setIsLoading(false);
              await onLoadMessages();
              markDone(sessionId);
            }
          }
        } catch (err) {
          console.error("Reconnection DB poll error:", err);
        }
      }, 3000);
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
