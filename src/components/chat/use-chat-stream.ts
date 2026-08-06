import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { ApprovalData, Message, ToolCallData } from "./types";
import type { TokenUsage } from "./input-bar";

/**
 * Shared SSE stream orchestration for chat.
 *
 * Single source of truth: the `messages` array. Streaming messages are
 * identified by `streaming-{turnId}` (turnId is a server-generated UUID that
 * is unique across generations — unlike the old turn-index scheme, it can
 * never collide). `message_saved` swaps the temp ID for the real DB ID.
 *
 * The connection is a KEEP-ALIVE observer: it stays open after `done` so a
 * generation started from another tab/session (web or Telegram worker) is
 * picked up live. Transport errors are handled by the browser's EventSource
 * auto-retry, which sends `Last-Event-ID` — the server replays buffered
 * events from there, so the client self-heals without manual reconnection.
 *
 * Server events:
 * - `turn_start { turnId }` — create a streaming message for the turn
 * - `token` / `thinking` / `tool_start` / `tool_end` — update the turn
 * - `turn_end { turnId }` — finalize the turn (safety net for final token)
 * - `message_saved { turnId, messageId }` — swap temp ID with the DB ID
 * - `done` — reload messages from DB; keep watching for the next generation
 * - `error` — terminal: reload, close the connection
 */

export interface ChatStreamOptions {
  sessionId: string;
  eventSourceRef: RefObject<EventSource | null>;
  setMessages: Dispatch<SetStateAction<Message[]>>;
  setIsLoading: Dispatch<SetStateAction<boolean>>;
  setPendingApprovals: Dispatch<SetStateAction<ApprovalData[]>>;
  markDone: (id: string) => void;
  onTokenUsage?: (usage: TokenUsage) => void;
  onCompactionStart?: () => void;
  onCompactionEnd?: (summary?: string, tokensBefore?: number) => void;
  /** Called with the error message when the server reports a stream error. */
  onStreamError?: (message: string) => void;
  /** Reload messages from the DB (called when the server signals a final state). */
  onReload: () => void;
}

export function useChatStream(options: ChatStreamOptions) {
  const { sessionId, eventSourceRef } = options;

  // Keep the latest options in a ref so `connect`'s memoization stays stable
  // even though callers pass inline callbacks (which change every render).
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  // Root (first turn) message ID — parentMessageId for subsequent turns of a
  // generation, so multi-turn runs group into a single bubble.
  const rootMessageIdRef = useRef<string | null>(null);

  /** Open (or reuse) the SSE connection for the session. */
  const connect = useCallback(() => {
    if (eventSourceRef.current) return;
    rootMessageIdRef.current = null;

    const eventSource = new EventSource(`/api/chat/sessions/${sessionId}/stream`);
    eventSourceRef.current = eventSource;

    wireStreamListeners({
      eventSource,
      rootMessageIdRef,
      ...optionsRef.current,
    });
  }, [sessionId, eventSourceRef]);

  /** Close the SSE connection (unmount, stop). */
  const disconnect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, [eventSourceRef]);

  return { connect, disconnect };
}

// ── SSE event wiring ───────────────────────────────────────────────────────────

interface StreamListenerOpts extends ChatStreamOptions {
  eventSource: EventSource;
  rootMessageIdRef: React.MutableRefObject<string | null>;
}

function wireStreamListeners(opts: StreamListenerOpts) {
  const { eventSource, setMessages, rootMessageIdRef } = opts;

  // isLoading is set on the first stream event (not on connect) so idle
  // chats don't flash a "Thinking…" indicator — the sidebar streaming dot
  // only lights up when a generation is actually streaming.
  let loadingSet = false;
  const markLoading = () => {
    if (!loadingSet) {
      loadingSet = true;
      opts.setIsLoading(true);
    }
  };

  /**
   * Ensure a streaming message exists for a turnId. Returns the updated
   * array (replaying events may arrive without the preceding turn_start,
   * e.g. when the buffer was trimmed).
   */
  const ensureTurnMessage = (
    prev: Message[],
    turnId: string,
    patch?: Partial<Message>,
  ): Message[] => {
    const id = `streaming-${turnId}`;
    if (prev.some((m) => m.id === id)) {
      return prev.map((m) => (m.id === id ? { ...m, ...patch } : m));
    }
    return [
      ...prev,
      {
        id,
        role: "assistant",
        content: "",
        thinking: undefined,
        toolCalls: undefined,
        parentMessageId: rootMessageIdRef.current || undefined,
        createdAt: new Date().toISOString(),
        attachments: undefined,
        ...patch,
      },
    ];
  };

  /**
   * Terminal cleanup: reload DB state, clear streaming leftovers, mark done.
   *
   * NOT terminal for the connection: it stays open so a generation started
   * from another tab/session streams on the same connection.
   */
  const handleDone = () => {
    loadingSet = false;
    opts.setIsLoading(false);
    setMessages((prev) => prev.filter((m) => !m.id.startsWith("streaming-")));
    // A `done` means the generation ended, so its approvals are resolved or
    // moot — drop any card that a missed resolution event left behind.
    opts.setPendingApprovals([]);
    rootMessageIdRef.current = null;
    opts.markDone(opts.sessionId);
    void opts.onReload();
  };

  // ── Turn start: create the streaming message ───────────────────────────
  eventSource.addEventListener("turn_start", (event: MessageEvent) => {
    markLoading();
    const parsed = JSON.parse(event.data) as { turnId: string };
    setMessages((prev) => ensureTurnMessage(prev, parsed.turnId));
  });

  // ── Token: update streaming message content ───────────────────────────
  eventSource.addEventListener("token", (event: MessageEvent) => {
    markLoading();
    let parsed: { turnId: string; text: string };
    try {
      parsed = JSON.parse(event.data) as { turnId: string; text: string };
    } catch (err) {
      console.error("Malformed token event:", err);
      return;
    }
    setMessages((prev) => ensureTurnMessage(prev, parsed.turnId, { content: parsed.text }));
  });

  // ── Thinking: update streaming message thinking ───────────────────────
  eventSource.addEventListener("thinking", (event: MessageEvent) => {
    markLoading();
    let parsed: { turnId: string; thinking: string };
    try {
      parsed = JSON.parse(event.data) as { turnId: string; thinking: string };
    } catch (err) {
      console.error("Malformed thinking event:", err);
      return;
    }
    setMessages((prev) =>
      ensureTurnMessage(prev, parsed.turnId, {
        thinking: parsed.thinking || undefined,
      }),
    );
  });

  // ── Tool start: add running tool call to the turn ─────────────────────
  eventSource.addEventListener("tool_start", (event: MessageEvent) => {
    markLoading();
    let parsed: {
      turnId: string;
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    };
    try {
      parsed = JSON.parse(event.data) as typeof parsed;
    } catch (err) {
      console.error("Malformed tool_start event:", err);
      return;
    }
    setMessages((prev) => {
      const id = `streaming-${parsed.turnId}`;
      const existing = prev.find((m) => m.id === id);
      if (!existing) {
        return ensureTurnMessage(prev, parsed.turnId, {
          toolCalls: [buildRunningToolCall(parsed)],
        });
      }
      // Dedupe — the same tool call may be re-delivered on reconnect.
      if (existing.toolCalls?.some((tc) => tc.id === parsed.toolCallId)) return prev;
      return prev.map((m) =>
        m.id === id
          ? { ...m, toolCalls: [...(m.toolCalls || []), buildRunningToolCall(parsed)] }
          : m,
      );
    });
  });

  // ── Tool end: update tool call status ─────────────────────────────────
  eventSource.addEventListener("tool_end", (event: MessageEvent) => {
    markLoading();
    let parsed: { turnId: string; toolCallId: string; result?: string; isError?: boolean };
    try {
      parsed = JSON.parse(event.data) as typeof parsed;
    } catch (err) {
      console.error("Malformed tool_end event:", err);
      return;
    }
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== `streaming-${parsed.turnId}` || !m.toolCalls) return m;
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

  // ── Turn end: finalize current turn (safety net for the final token) ──
  eventSource.addEventListener("turn_end", (event: MessageEvent) => {
    markLoading();
    let parsed: { turnId: string; text?: string; thinking?: string | null };
    try {
      parsed = JSON.parse(event.data) as typeof parsed;
    } catch (err) {
      console.error("Malformed turn_end event:", err);
      return;
    }
    setMessages((prev) =>
      ensureTurnMessage(prev, parsed.turnId, {
        ...(parsed.text ? { content: parsed.text } : {}),
        ...(parsed.thinking ? { thinking: parsed.thinking } : {}),
      }),
    );
  });

  // ── Message saved: swap temp ID with real DB ID ───────────────────────
  eventSource.addEventListener("message_saved", (event: MessageEvent) => {
    let parsed: { turnId: string; messageId: string };
    try {
      parsed = JSON.parse(event.data) as typeof parsed;
    } catch (err) {
      console.error("Malformed message_saved event:", err);
      return;
    }
    // First saved message of a generation = the root (parent of later turns).
    if (!rootMessageIdRef.current) {
      rootMessageIdRef.current = parsed.messageId;
    }
    setMessages((prev) =>
      prev.map((m) => (m.id === `streaming-${parsed.turnId}` ? { ...m, id: parsed.messageId } : m)),
    );
  });

  // ── Approval request ──────────────────────────────────────────────────
  eventSource.addEventListener("tool_approval_request", (event: MessageEvent) => {
    markLoading();
    let parsed: ApprovalData;
    try {
      parsed = JSON.parse(event.data) as ApprovalData;
    } catch (err) {
      console.error("Malformed tool_approval_request event:", err);
      return;
    }
    opts.setPendingApprovals((prev) => {
      if (prev.some((a) => a.toolCallId === parsed.toolCallId)) return prev;
      return [...prev, parsed];
    });
  });

  // ── Approval resolved (any process: web UI, Telegram, timeout, stop) ──
  // Removes the card so a request that was decided elsewhere (or expired)
  // can never linger as a stuck "awaiting approval".
  eventSource.addEventListener("tool_approval_resolved", (event: MessageEvent) => {
    let parsed: { toolCallId: string; approved: boolean };
    try {
      parsed = JSON.parse(event.data) as typeof parsed;
    } catch (err) {
      console.error("Malformed tool_approval_resolved event:", err);
      return;
    }
    opts.setPendingApprovals((prev) => prev.filter((a) => a.toolCallId !== parsed.toolCallId));
  });

  // ── Approval snapshot (server truth, sent after every (re)connect) ───
  // Replaces the local list so stale cards — resolved elsewhere, expired,
  // or orphaned by a crashed generation — are dropped on reconnection.
  eventSource.addEventListener("approvals_snapshot", (event: MessageEvent) => {
    let parsed: { approvals?: ApprovalData[] };
    try {
      parsed = JSON.parse(event.data) as typeof parsed;
    } catch (err) {
      console.error("Malformed approvals_snapshot event:", err);
      return;
    }
    opts.setPendingApprovals(parsed.approvals ?? []);
  });

  // ── Token usage ───────────────────────────────────────────────────────
  if (opts.onTokenUsage) {
    eventSource.addEventListener("token_usage", (event: MessageEvent) => {
      let parsed: TokenUsage;
      try {
        parsed = JSON.parse(event.data) as TokenUsage;
      } catch (err) {
        console.error("Malformed token_usage event:", err);
        return;
      }
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
      let parsed: { summary?: string; tokensBefore?: number; aborted?: boolean };
      try {
        parsed = JSON.parse(event.data) as typeof parsed;
      } catch (err) {
        console.error("Malformed compaction_end event:", err);
        return;
      }
      if (!parsed.aborted) {
        opts.onCompactionEnd!(parsed.summary, parsed.tokensBefore);
      } else {
        opts.onCompactionEnd!();
      }
    });
  }

  // ── Done: reload DB state, keep watching for the next generation ──────
  eventSource.addEventListener("done", () => {
    handleDone();
  });

  // ── Error (named SSE event only) — terminal ───────────────────────────
  // addEventListener catches both named "error" SSE events (with JSON data)
  // AND transport-level errors (empty data). Only events with data are real
  // errors — transport errors are handled by onerror below.
  eventSource.addEventListener("error", (event: MessageEvent) => {
    if (!event.data) return; // Transport error — handled by onerror

    let message = "Stream error";
    try {
      const parsed = JSON.parse(event.data) as { message?: string };
      message = parsed.message || message;
    } catch {
      console.error("Stream error (invalid JSON):", event.data);
    }
    console.error("Stream error:", message);
    opts.onStreamError?.(message);

    // Terminal — close the connection (do NOT let the browser retry-loop on
    // persistent errors).
    eventSource.close();
    opts.eventSourceRef.current = null;
    handleDone();
  });

  // ── Transport error — the browser auto-reconnects with Last-Event-ID and
  //    the server replays buffered events, so we don't need to do anything.
  eventSource.onerror = () => {
    // Auto-reconnect handled by the browser.
  };
}

function buildRunningToolCall(parsed: {
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
