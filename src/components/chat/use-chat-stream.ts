import { useCallback, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Message, ApprovalData } from "./types";
import type { TokenUsage } from "./input-bar";

/**
 * Shared SSE stream orchestration for chat.
 *
 * Single source of truth: the `messages` array.
 * Streaming messages are added with `streaming-{turnIndex}` IDs and
 * updated in-place as tokens arrive. No separate streaming state.
 *
 * Server events:
 * - `token` / `thinking` — update the current streaming message in-place
 * - `tool_start` / `tool_end` — update tool calls on the streaming message
 * - `turn_end` — finalize current turn, create next streaming message
 * - `message_saved` — swap temp ID with real DB ID
 * - `done` — close connection, remove any remaining streaming messages
 * - `error` — close connection, show error
 */
export function useChatStream(
  sessionId: string,
  eventSourceRef: React.RefObject<EventSource | null>,
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
  const lastEventIdRef = useRef("");
  // Track the root (first turn) message ID for parentMessageId of subsequent turns.
  const rootMessageIdRef = useRef<string | null>(null);
  // Track which turns have been saved to DB (for correct turn index on reconnect).
  const savedTurnsRef = useRef(new Set<number>());

  /** Close the current EventSource and clear refs. */
  const closeEventSource = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, [eventSourceRef]);

  /** Wire up approval request handler. */
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
   * Common cleanup: close EventSource, clear timers.
   */
  const cleanup = useCallback(
    (es: EventSource) => {
      es.close();
      eventSourceRef.current = null;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    },
    [eventSourceRef],
  );

  /**
   * Remove any remaining streaming messages from the array.
   */
  const removeStreamingMessages = useCallback(() => {
    setMessages((prev) => prev.filter((m) => !m.id.startsWith("streaming-")));
  }, [setMessages]);

  /**
   * Start reconnection via SSE. Used when user refreshes during generation
   * or gets a 409 (already processing).
   */
  const startReconnection = useCallback(
    (onLoadMessages: () => Promise<unknown>, _onLoadSessionTitle: () => Promise<unknown>) => {
      closeEventSource();
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }

      // Reset refs for reconnection
      savedTurnsRef.current = new Set();
      rootMessageIdRef.current = null;

      setIsLoading(true);

      const reconnectUrl = lastEventIdRef.current
        ? `/api/chat/sessions/${sessionId}/stream?lastEventId=${lastEventIdRef.current}`
        : `/api/chat/sessions/${sessionId}/stream`;

      const eventSource = new EventSource(reconnectUrl);
      eventSourceRef.current = eventSource;

      const onDone = () => {
        cleanup(eventSource);
        setIsLoading(false);
        removeStreamingMessages();
        void onLoadMessages();
        markDone(sessionId);
      };

      wireStreamListeners({
        eventSource,
        sessionId,
        setMessages,
        setPendingApprovals,
        lastEventIdRef,
        rootMessageIdRef,
        savedTurnsRef,
        onDone,
        onTokenUsage,
        onCompactionStart,
        onCompactionEnd,
        handleApprovalRequest,
      });

      // Safety timeout — if still loading after 30s, force-clear and reload from DB.
      reconnectTimerRef.current = setTimeout(() => {
        cleanup(eventSource);
        setIsLoading(false);
        removeStreamingMessages();
        void onLoadMessages();
        markDone(sessionId);
      }, 30_000);
    },
    [
      sessionId,
      closeEventSource,
      setIsLoading,
      setMessages,
      setPendingApprovals,
      markDone,
      eventSourceRef,
      lastEventIdRef,
      cleanup,
      removeStreamingMessages,
      onTokenUsage,
      onCompactionStart,
      onCompactionEnd,
      handleApprovalRequest,
    ],
  );

  /**
   * Connect to a stream URL and wire up listeners.
   * Returns the EventSource so the caller can close it on error.
   */
  const connectStream = useCallback(
    (streamUrl: string) => {
      // Reset refs for new connection
      savedTurnsRef.current = new Set();
      rootMessageIdRef.current = null;

      // Add initial streaming message (turn 0)
      setMessages((prev) => [
        ...prev,
        {
          id: "streaming-0",
          role: "assistant",
          content: "",
          thinking: undefined,
          toolCalls: undefined,
          parentMessageId: undefined,
          createdAt: new Date().toISOString(),
          attachments: undefined,
        },
      ]);

      const eventSource = new EventSource(streamUrl);
      eventSourceRef.current = eventSource;

      const onDone = () => {
        cleanup(eventSource);
        setIsLoading(false);
        removeStreamingMessages();
      };

      wireStreamListeners({
        eventSource,
        sessionId,
        setMessages,
        setPendingApprovals,
        lastEventIdRef,
        rootMessageIdRef,
        savedTurnsRef,
        onDone,
        onTokenUsage,
        onCompactionStart,
        onCompactionEnd,
        handleApprovalRequest,
      });

      return eventSource;
    },
    [
      sessionId,
      setMessages,
      setPendingApprovals,
      setIsLoading,
      eventSourceRef,
      lastEventIdRef,
      cleanup,
      removeStreamingMessages,
      onTokenUsage,
      onCompactionStart,
      onCompactionEnd,
      handleApprovalRequest,
    ],
  );

  return {
    startReconnection,
    connectStream,
    closeEventSource,
    reconnectTimerRef,
  };
}

// ── SSE event wiring ───────────────────────────────────────────────────────────

interface StreamListenerOpts {
  eventSource: EventSource;
  sessionId: string;
  setMessages: Dispatch<SetStateAction<Message[]>>;
  setPendingApprovals: Dispatch<SetStateAction<ApprovalData[]>>;
  lastEventIdRef: React.MutableRefObject<string>;
  rootMessageIdRef: React.MutableRefObject<string | null>;
  savedTurnsRef: React.MutableRefObject<Set<number>>;
  onDone: () => void;
  onTokenUsage: ((usage: TokenUsage) => void) | undefined;
  onCompactionStart: (() => void) | undefined;
  onCompactionEnd: ((summary?: string, tokensBefore?: number) => void) | undefined;
  handleApprovalRequest: (request: ApprovalData) => void;
}

function wireStreamListeners(opts: StreamListenerOpts) {
  const { eventSource, setMessages, lastEventIdRef, rootMessageIdRef, savedTurnsRef } = opts;

  // Track last event ID for potential reconnection.
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
    "message_saved",
    "done",
    "error",
  ] as const) {
    eventSource.addEventListener(type, trackEventId);
  }

  // ── Token: update streaming message content ───────────────────────────
  eventSource.addEventListener("token", (event: MessageEvent) => {
    const parsed = JSON.parse(event.data) as { text: string };
    setMessages((prev) => {
      const currentId = getCurrentStreamingId(prev);
      // If no streaming message exists (e.g. reconnect mid-turn), create one
      if (currentId === "streaming-0" && !prev.some((m) => m.id.startsWith("streaming-"))) {
        const nextTurn = getNextStreamingTurn(prev, savedTurnsRef.current);
        return [
          ...prev,
          {
            id: `streaming-${nextTurn}`,
            role: "assistant",
            content: parsed.text,
            thinking: undefined,
            toolCalls: undefined,
            parentMessageId: rootMessageIdRef.current || undefined,
            createdAt: new Date().toISOString(),
            attachments: undefined,
          },
        ];
      }
      return prev.map((m) => (m.id === currentId ? { ...m, content: parsed.text } : m));
    });
  });

  // ── Thinking: update streaming message thinking ───────────────────────
  eventSource.addEventListener("thinking", (event: MessageEvent) => {
    const parsed = JSON.parse(event.data) as { thinking: string };
    setMessages((prev) => {
      const currentId = getCurrentStreamingId(prev);
      // If no streaming message exists (e.g. reconnect mid-turn), create one
      if (currentId === "streaming-0" && !prev.some((m) => m.id.startsWith("streaming-"))) {
        const nextTurn = getNextStreamingTurn(prev, savedTurnsRef.current);
        return [
          ...prev,
          {
            id: `streaming-${nextTurn}`,
            role: "assistant",
            content: "",
            thinking: parsed.thinking || undefined,
            toolCalls: undefined,
            parentMessageId: rootMessageIdRef.current || undefined,
            createdAt: new Date().toISOString(),
            attachments: undefined,
          },
        ];
      }
      return prev.map((m) =>
        m.id === currentId ? { ...m, thinking: parsed.thinking || undefined } : m,
      );
    });
  });

  // ── Tool start: add running tool call to streaming message ────────────
  eventSource.addEventListener("tool_start", (event: MessageEvent) => {
    const parsed = JSON.parse(event.data) as {
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    };
    setMessages((prev) => {
      const currentId = getCurrentStreamingId(prev);
      // If no streaming message exists (e.g. reconnect mid-tool), create one
      if (currentId === "streaming-0" && !prev.some((m) => m.id.startsWith("streaming-"))) {
        const nextTurn = getNextStreamingTurn(prev, savedTurnsRef.current);
        return [
          ...prev,
          {
            id: `streaming-${nextTurn}`,
            role: "assistant",
            content: "",
            thinking: undefined,
            toolCalls: [
              {
                id: parsed.toolCallId,
                name: parsed.toolName,
                args: parsed.args,
                status: "running" as const,
                result: undefined,
                error: undefined,
              },
            ],
            parentMessageId: rootMessageIdRef.current || undefined,
            createdAt: new Date().toISOString(),
            attachments: undefined,
          },
        ];
      }
      return prev.map((m) => {
        if (m.id !== currentId) return m;
        return {
          ...m,
          toolCalls: [
            ...(m.toolCalls || []),
            {
              id: parsed.toolCallId,
              name: parsed.toolName,
              args: parsed.args,
              status: "running" as const,
              result: undefined,
              error: undefined,
            },
          ],
        };
      });
    });
  });

  // ── Tool end: update tool call status ─────────────────────────────────
  eventSource.addEventListener("tool_end", (event: MessageEvent) => {
    const parsed = JSON.parse(event.data) as {
      toolCallId: string;
      result?: string;
      isError?: boolean;
    };
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== getCurrentStreamingId(prev) || !m.toolCalls) return m;
        return {
          ...m,
          toolCalls: m.toolCalls.map((tc) =>
            tc.id === parsed.toolCallId
              ? {
                  ...tc,
                  status: parsed.isError ? ("error" as const) : ("completed" as const),
                  result: parsed.result ?? undefined,
                  error: parsed.isError ? (parsed.result ?? undefined) : undefined,
                }
              : tc,
          ),
        };
      }),
    );
  });

  // ── Turn end: finalize current turn, add next streaming message ───────
  eventSource.addEventListener("turn_end", (event: MessageEvent) => {
    const parsed = JSON.parse(event.data) as {
      turnIndex: number;
      text?: string;
      thinking?: string;
    };
    setMessages((prev) => {
      const nextTurn = parsed.turnIndex + 1;
      const nextId = `streaming-${nextTurn}`;
      // Don't create a duplicate if the streaming message already exists
      // (e.g. content events created it before turn_end on buffer replay)
      if (prev.some((m) => m.id === nextId)) {
        return prev;
      }
      const rootId = rootMessageIdRef.current;
      return [
        ...prev,
        {
          id: nextId,
          role: "assistant",
          content: "",
          thinking: undefined,
          toolCalls: undefined,
          parentMessageId: rootId || undefined,
          createdAt: new Date().toISOString(),
          attachments: undefined,
        },
      ];
    });
  });

  // ── Message saved: swap temp ID with real DB ID ───────────────────────
  eventSource.addEventListener("message_saved", (event: MessageEvent) => {
    const parsed = JSON.parse(event.data) as { messageId: string; turnIndex: number };
    // Track the root (first turn) message ID for parentMessageId of subsequent turns
    if (parsed.turnIndex === 0) {
      rootMessageIdRef.current = parsed.messageId;
    }
    // Track saved turns for correct turn index on reconnect
    savedTurnsRef.current.add(parsed.turnIndex);
    setMessages((prev) =>
      prev.map((m) =>
        m.id === `streaming-${parsed.turnIndex}` ? { ...m, id: parsed.messageId } : m,
      ),
    );
  });

  // ── Approval request ──────────────────────────────────────────────────
  eventSource.addEventListener("tool_approval_request", (event: MessageEvent) => {
    const parsed = JSON.parse(event.data) as ApprovalData;
    opts.handleApprovalRequest(parsed);
  });

  // ── Token usage ───────────────────────────────────────────────────────
  if (opts.onTokenUsage) {
    eventSource.addEventListener("token_usage", (event: MessageEvent) => {
      const parsed = JSON.parse(event.data) as TokenUsage;
      opts.onTokenUsage!(parsed);
    });
  }

  // ── Compaction ────────────────────────────────────────────────────────
  if (opts.onCompactionStart) {
    eventSource.addEventListener("compaction_start", () => {
      opts.onCompactionStart!();
    });
  }

  if (opts.onCompactionEnd) {
    eventSource.addEventListener("compaction_end", (event: MessageEvent) => {
      const parsed = JSON.parse(event.data) as {
        summary?: string;
        tokensBefore?: number;
        aborted?: boolean;
      };
      if (!parsed.aborted) {
        opts.onCompactionEnd!(parsed.summary, parsed.tokensBefore);
      } else {
        opts.onCompactionEnd!();
      }
    });
  }

  // ── Done ──────────────────────────────────────────────────────────────
  eventSource.addEventListener("done", () => {
    opts.onDone();
  });

  // ── Error ─────────────────────────────────────────────────────────────
  eventSource.addEventListener("error", (event: MessageEvent) => {
    const parsed = JSON.parse(event.data);
    console.error("Stream error:", parsed);
    opts.onDone();
  });

  // ── Connection error — EventSource auto-reconnects, don't trigger done ─
  eventSource.onerror = () => {
    // Auto-reconnect handled by browser
  };
}

/** Get the ID of the current streaming message (highest turn index). */
function getCurrentStreamingId(messages: Message[]): string {
  let maxTurn = -1;
  for (const m of messages) {
    if (m.id.startsWith("streaming-")) {
      const turn = parseInt(m.id.slice("streaming-".length), 10);
      if (!isNaN(turn) && turn > maxTurn) {
        maxTurn = turn;
      }
    }
  }
  return maxTurn >= 0 ? `streaming-${maxTurn}` : "streaming-0";
}

/** Get the next streaming turn index (one higher than the current max). */
function getNextStreamingTurn(messages: Message[], savedTurns: Set<number>): number {
  let maxTurn = -1;
  // Check existing streaming messages
  for (const m of messages) {
    if (m.id.startsWith("streaming-")) {
      const turn = parseInt(m.id.slice("streaming-".length), 10);
      if (!isNaN(turn) && turn > maxTurn) {
        maxTurn = turn;
      }
    }
  }
  // Also check saved turns (turns that have been persisted to DB)
  for (const turn of savedTurns) {
    if (turn > maxTurn) {
      maxTurn = turn;
    }
  }
  return maxTurn + 1;
}
