import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type {
  ApprovalData,
  Message,
  PluginDialogData,
  PluginStatusData,
  PluginWidgetData,
  TokenUsage,
} from "./types";
import { streamReducer, type StreamAction } from "@/lib/chat/stream-reducer";

/**
 * How long the client tolerates silence from the SSE connection before
 * declaring it dead and forcing a reconnect. The server pings every 15s, so a
 * healthy connection is never silent for more than ~15s; 60s means at least
 * three heartbeats were lost.
 */
const STALL_THRESHOLD_MS = 60_000;
/** How often the watchdog checks for stalls. */
const WATCHDOG_TICK_MS = 15_000;

/**
 * Fallback batching interval for an environment with no animation frames.
 * Real browsers always have them (see the coalesced dispatch below).
 */
const FRAME_FALLBACK_MS = 16;

/**
 * Shared SSE stream orchestration for chat.
 *
 * Single source of truth: the `messages` array. Streaming messages are
 * identified by `streaming-{turnId}` (turnId is a server-generated UUID that
 * is unique across generations. unlike the old turn-index scheme, it can
 * never collide). `message_saved` swaps the temp ID for the real DB ID.
 *
 * The connection is a KEEP-ALIVE observer: it stays open after `done` so a
 * generation started from another tab/session (web or Telegram worker) is
 * picked up live. Transport errors are handled by the browser's EventSource
 * auto-retry, which sends `Last-Event-ID`. the server replays buffered
 * events from there, so the client self-heals without manual reconnection.
 * Reconnects that start a NEW EventSource (the stall watchdog, a reconnect
 * after a send) replay the whole buffer instead, so replayed events must land
 * on the turns already on screen. the reducer identifies them by the tag on
 * the message, not by the temp id `message_saved` replaced (see
 * `stream-reducer`).
 *
 * All message-state transitions are handled by the pure `streamReducer`
 * (unit-tested in `__tests__/lib/chat/stream-reducer.test.ts`); this module
 * only parses event JSON, dispatches actions, and runs side effects
 * (loading flags, approvals, sidebar markers, DB reloads).
 *
 * Server events:
 * - `turn_start { turnId, startedAt }`. create a streaming message for the
 *   turn, positioned by the server's turn start
 * - `token` / `thinking` / `tool_pending` / `tool_start` / `tool_update` /
 *   `tool_end`. update the turn (`tool_pending` is a call whose arguments the
 *   model is still writing, `tool_update` carries live partial output from a
 *   running tool; tool_end carries toolName so the UI can react to specific
 *   tools)
 * - `turn_end { turnId }`. finalize the turn (safety net for final token)
 * - `turn_discarded { turnId }`. the SDK discarded a failed turn to retry it
 * - `retry_start` / `retry_end`. the provider call failed and is being retried
 * - `message_saved { turnId, messageId }`. swap temp ID with the DB ID
 * - `queue_update { messages }`. the send queue changed (a message was
 *   queued, edited, cancelled, or delivered)
 * - `messages_changed`. the conversation changed outside this stream (a
 *   tool posted a message into it). reload from the DB
 * - `done`. reload messages from DB; keep watching for the next generation
 * - `error`. terminal: reload, close the connection
 *
 * Heartbeat/watchdog: the server sends `event: ping` every 15s (unbuffered,
 * no id). The browser's EventSource only auto-reconnects on transport errors
 *. a silently half-open connection (proxy dropped, server wedged) would
 * stall forever. If no ping arrives within STALL_THRESHOLD_MS while the
 * connection reports OPEN, we close it and reconnect; the server replays the
 * buffer, so nothing is lost.
 */

export interface ChatStreamOptions {
  sessionId: string;
  eventSourceRef: RefObject<EventSource | null>;
  setMessages: Dispatch<SetStateAction<Message[]>>;
  setIsLoading: Dispatch<SetStateAction<boolean>>;
  setPendingApprovals: Dispatch<SetStateAction<ApprovalData[]>>;
  /** Dialogs a plugin opened in this chat. */
  setPluginDialogs: Dispatch<SetStateAction<PluginDialogData[]>>;
  /** A plugin asked to tell the user something. Shown as a toast. */
  onPluginNotice?: (notice: { message: string; type: "info" | "warning" | "error" }) => void;
  /** A plugin set (or cleared) a status line. */
  onPluginStatus?: (status: PluginStatusData) => void;
  /** A plugin set (or cleared) a panel above/below the composer. */
  onPluginWidget?: (widget: PluginWidgetData) => void;
  /** A plugin put text in the composer. */
  onPluginComposerText?: (text: string) => void;
  markDone: (id: string) => void;
  onTokenUsage?: (usage: TokenUsage) => void;
  onCompactionStart?: () => void;
  onCompactionEnd?: (summary?: string, tokensBefore?: number) => void;
  /** Called with the error message when the server reports a stream error. */
  onStreamError?: (message: string) => void;
  /** The provider call failed and is being retried after a backoff. */
  onRetryStart?: (retry: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    errorMessage: string;
  }) => void;
  /** A provider retry finished. successfully, or with the run giving up. */
  onRetryEnd?: (retry: { success: boolean; attempt: number; finalError?: string }) => void;
  /** Reload messages from the DB (called when the server signals a final state). */
  onReload: () => void;
  /** Called with the tool name each time a tool call finishes. */
  onToolEnd?: (toolName: string) => void;
  /**
   * The send queue changed. Carries the full queue, so the client never has
   * to merge deltas. Called for queue mutations and at every run start, which
   * is how a delivered message leaves the queue strip.
   */
  onQueueUpdate?: (messages: Message[]) => void;
  /**
   * Called when a generation ends (any `done`, including stop/error cleanup).
   * The send queue drains server-side. this only clears per-run UI state.
   */
  onGenerationEnd?: () => void;
}

export function useChatStream(options: ChatStreamOptions) {
  const { sessionId, eventSourceRef } = options;

  // Keep the latest options in a ref so `connect`'s memoization stays stable
  // even though callers pass inline callbacks (which change every render).
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  // Root (first turn) message ID. parentMessageId for subsequent turns of a
  // generation, so multi-turn runs group into a single bubble.
  const rootMessageIdRef = useRef<string | null>(null);

  // Watchdog bookkeeping: the reconnect tick must be cleared on disconnect and
  // superseded on every new connection; `connectRef` lets the watchdog call
  // `connect` without a circular useCallback dependency.
  const watchdogRef = useRef<number | null>(null);
  const connectRef = useRef<() => void>(() => {});

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

    // ── Watchdog: force a reconnect if the server stops sending pings. ──
    if (watchdogRef.current !== null) clearInterval(watchdogRef.current);
    let lastPingAt = Date.now();
    eventSource.addEventListener("ping", () => {
      lastPingAt = Date.now();
    });
    watchdogRef.current = window.setInterval(() => {
      // If the browser is already reconnecting, leave it alone.
      if (eventSource.readyState !== EventSource.OPEN) return;
      if (Date.now() - lastPingAt <= STALL_THRESHOLD_MS) return;
      console.warn(
        `[chat-stream] no heartbeat for ${STALL_THRESHOLD_MS}ms. connection presumed dead, reconnecting`,
      );
      eventSource.close();
      eventSourceRef.current = null;
      connectRef.current();
    }, WATCHDOG_TICK_MS);
  }, [sessionId, eventSourceRef]);

  // Keep the watchdog's escape hatch pointed at the latest `connect` (stable:
  // its deps never change). Placed after the declaration to avoid the
  // use-before-declaration lint on the eager dependency array.
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  /** Close the SSE connection (unmount, stop). */
  const disconnect = useCallback(() => {
    if (watchdogRef.current !== null) {
      clearInterval(watchdogRef.current);
      watchdogRef.current = null;
    }
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

export function wireStreamListeners(opts: StreamListenerOpts) {
  const { eventSource, setMessages, rootMessageIdRef } = opts;

  // isLoading is set on the first stream event (not on connect) so idle
  // chats don't flash a "Thinking…" indicator. the sidebar streaming dot
  // only lights up when a generation is actually streaming.
  let loadingSet = false;
  const markLoading = () => {
    if (!loadingSet) {
      loadingSet = true;
      opts.setIsLoading(true);
    }
  };

  /**
   * Route a parsed stream event through the pure reducer. All message-state
   * transitions live there (unit-tested); here we only glue React state.
   *
   * Cumulative events. a token, a reasoning chunk, a tool's live output. are
   * queued and applied once per frame instead of once per event. Each one
   * re-renders the transcript (markdown, highlighting, layout), and a provider
   * emits them faster than any screen refreshes: rendering every one of them
   * saturated the main thread, and scrolling the transcript while a run
   * streamed came to feel stuck because the scroll never got a frame.
   * Everything else is applied immediately, after whatever is queued, so the
   * reducer still sees events in order.
   *
   * `rootMessageId` is captured per queued action: the ref moves on at
   * `message_saved`, and a queued token must still be grouped by the root it
   * arrived under.
   */
  interface QueuedAction {
    action: StreamAction;
    rootMessageId: string | null;
  }
  let queued: QueuedAction[] = [];
  /** Cancels the frame (or fallback timer) that will apply the queue. */
  let cancelScheduled: (() => void) | null = null;

  /** Run `callback` on the next frame, or the next tick where there is none. */
  const scheduleFlush = (callback: () => void): (() => void) => {
    if (typeof requestAnimationFrame === "function") {
      const id = requestAnimationFrame(callback);
      return () => cancelAnimationFrame(id);
    }
    const id = setTimeout(callback, FRAME_FALLBACK_MS);
    return () => clearTimeout(id);
  };

  const applyQueued = () => {
    if (queued.length === 0) return;
    const batch = queued;
    queued = [];
    setMessages((prev) => {
      let messages = prev;
      for (const { action, rootMessageId } of batch) {
        messages = streamReducer({ messages, rootMessageId }, action).messages;
      }
      return messages;
    });
  };

  const flushQueued = () => {
    cancelScheduled?.();
    cancelScheduled = null;
    applyQueued();
  };

  const dispatch = (action: StreamAction, { coalesce = false }: { coalesce?: boolean } = {}) => {
    queued.push({ action, rootMessageId: rootMessageIdRef.current });
    if (!coalesce) {
      flushQueued();
      return;
    }
    if (cancelScheduled === null) {
      cancelScheduled = scheduleFlush(() => {
        cancelScheduled = null;
        applyQueued();
      });
    }
  };

  /** Parse an SSE payload; malformed events are logged and dropped. */
  const parseEvent = <T>(data: string): T | null => {
    try {
      return JSON.parse(data) as T;
    } catch (err) {
      console.error("Malformed SSE event:", err);
      return null;
    }
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
    dispatch({ type: "generation_done" });
    // A `done` means the generation ended, so its approvals are resolved or
    // moot. drop any card that a missed resolution event left behind.
    opts.setPendingApprovals([]);
    opts.setPluginDialogs([]);
    rootMessageIdRef.current = null;
    opts.markDone(opts.sessionId);
    // Pi's followUp semantics: anything queued while Pi was busy is delivered
    // now that the agent stopped.
    opts.onGenerationEnd?.();
    void opts.onReload();
  };

  // ── Turn lifecycle: all state changes go through the reducer ──────────
  eventSource.addEventListener("turn_start", (event: MessageEvent) => {
    markLoading();
    const parsed = parseEvent<{ turnId: string; startedAt?: string }>(event.data);
    if (parsed) {
      dispatch({
        type: "turn_start",
        turnId: parsed.turnId,
        ...(parsed.startedAt !== undefined ? { startedAt: parsed.startedAt } : {}),
      });
    }
  });

  eventSource.addEventListener("token", (event: MessageEvent) => {
    markLoading();
    const parsed = parseEvent<{ turnId: string; text: string }>(event.data);
    if (parsed)
      dispatch({ type: "token", turnId: parsed.turnId, text: parsed.text }, { coalesce: true });
  });

  eventSource.addEventListener("thinking", (event: MessageEvent) => {
    markLoading();
    const parsed = parseEvent<{ turnId: string; thinking: string }>(event.data);
    if (parsed) {
      dispatch(
        { type: "thinking", turnId: parsed.turnId, thinking: parsed.thinking },
        { coalesce: true },
      );
    }
  });

  eventSource.addEventListener("tool_pending", (event: MessageEvent) => {
    markLoading();
    const parsed = parseEvent<{
      turnId: string;
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }>(event.data);
    if (parsed) {
      dispatch({
        type: "tool_pending",
        turnId: parsed.turnId,
        toolCallId: parsed.toolCallId,
        toolName: parsed.toolName,
        args: parsed.args ?? {},
      });
    }
  });

  eventSource.addEventListener("tool_start", (event: MessageEvent) => {
    markLoading();
    const parsed = parseEvent<{
      turnId: string;
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }>(event.data);
    if (parsed) {
      dispatch({
        type: "tool_start",
        turnId: parsed.turnId,
        toolCallId: parsed.toolCallId,
        toolName: parsed.toolName,
        args: parsed.args,
      });
    }
  });

  eventSource.addEventListener("tool_update", (event: MessageEvent) => {
    markLoading();
    const parsed = parseEvent<{ turnId: string; toolCallId: string; partialResult?: string }>(
      event.data,
    );
    if (parsed) {
      dispatch(
        {
          type: "tool_update",
          turnId: parsed.turnId,
          toolCallId: parsed.toolCallId,
          ...(parsed.partialResult !== undefined ? { partialResult: parsed.partialResult } : {}),
        },
        { coalesce: true },
      );
    }
  });

  eventSource.addEventListener("tool_end", (event: MessageEvent) => {
    markLoading();
    const parsed = parseEvent<{
      turnId: string;
      toolCallId: string;
      toolName?: string;
      result?: string;
      isError?: boolean;
    }>(event.data);
    if (parsed) {
      dispatch({
        type: "tool_end",
        turnId: parsed.turnId,
        toolCallId: parsed.toolCallId,
        ...(parsed.result !== undefined ? { result: parsed.result } : {}),
        ...(parsed.isError !== undefined ? { isError: parsed.isError } : {}),
      });
      if (parsed.toolName) opts.onToolEnd?.(parsed.toolName);
    }
  });

  eventSource.addEventListener("turn_end", (event: MessageEvent) => {
    markLoading();
    const parsed = parseEvent<{ turnId: string; text?: string; thinking?: string | null }>(
      event.data,
    );
    if (parsed) {
      dispatch({
        type: "turn_end",
        turnId: parsed.turnId,
        ...(parsed.text !== undefined ? { text: parsed.text } : {}),
        ...(parsed.thinking ? { thinking: parsed.thinking } : {}),
      });
    }
  });

  // ── Discarded turn: the SDK is retrying a failed call ─────────────────
  eventSource.addEventListener("turn_discarded", (event: MessageEvent) => {
    const parsed = parseEvent<{ turnId: string; messageId: string | null }>(event.data);
    if (!parsed) return;
    if (parsed.messageId && rootMessageIdRef.current === parsed.messageId) {
      rootMessageIdRef.current = null;
    }
    dispatch({ type: "turn_discarded", turnId: parsed.turnId, messageId: parsed.messageId });
  });

  // ── Message saved: swap temp ID with real DB ID ───────────────────────
  eventSource.addEventListener("message_saved", (event: MessageEvent) => {
    const parsed = parseEvent<{ turnId: string; messageId: string }>(event.data);
    if (!parsed) return;
    // First saved message of a generation = the root (parent of later turns).
    if (!rootMessageIdRef.current) {
      rootMessageIdRef.current = parsed.messageId;
    }
    dispatch({
      type: "message_saved",
      turnId: parsed.turnId,
      messageId: parsed.messageId,
      receivedAt: Date.now(),
    });
  });

  // ── Approval request ──────────────────────────────────────────────────
  eventSource.addEventListener("tool_approval_request", (event: MessageEvent) => {
    markLoading();
    const parsed = parseEvent<ApprovalData>(event.data);
    if (!parsed) return;
    opts.setPendingApprovals((prev) => {
      if (prev.some((a) => a.toolCallId === parsed.toolCallId)) return prev;
      return [...prev, parsed];
    });
  });

  // ── Approval resolved (any process: web UI, Telegram, timeout, stop) ──
  // Removes the card so a request that was decided elsewhere (or expired)
  // can never linger as a stuck "awaiting approval".
  eventSource.addEventListener("tool_approval_resolved", (event: MessageEvent) => {
    const parsed = parseEvent<{ toolCallId: string; approved: boolean }>(event.data);
    if (!parsed) return;
    opts.setPendingApprovals((prev) => prev.filter((a) => a.toolCallId !== parsed.toolCallId));
  });

  // ── Approval snapshot (server truth, sent after every (re)connect) ───
  // Replaces the local list so stale cards. resolved elsewhere, expired,
  // or orphaned by a crashed generation. are dropped on reconnection.
  eventSource.addEventListener("approvals_snapshot", (event: MessageEvent) => {
    const parsed = parseEvent<{ approvals?: ApprovalData[] }>(event.data);
    if (!parsed) return;
    opts.setPendingApprovals(parsed.approvals ?? []);
  });

  // ── Plugin UI (Pi's `ctx.ui` from a plugin) ───────────────────────────
  eventSource.addEventListener("plugin_ui_request", (event: MessageEvent) => {
    markLoading();
    const parsed = parseEvent<PluginDialogData>(event.data);
    if (!parsed) return;
    opts.setPluginDialogs((prev) =>
      prev.some((dialog) => dialog.id === parsed.id) ? prev : [...prev, parsed],
    );
  });

  eventSource.addEventListener("plugin_ui_resolved", (event: MessageEvent) => {
    const parsed = parseEvent<{ id: string }>(event.data);
    if (!parsed) return;
    opts.setPluginDialogs((prev) => prev.filter((dialog) => dialog.id !== parsed.id));
  });

  eventSource.addEventListener("plugin_ui_snapshot", (event: MessageEvent) => {
    const parsed = parseEvent<{ dialogs?: PluginDialogData[] }>(event.data);
    if (!parsed) return;
    opts.setPluginDialogs(parsed.dialogs ?? []);
  });

  eventSource.addEventListener("plugin_notice", (event: MessageEvent) => {
    const parsed = parseEvent<{ message: string; type: "info" | "warning" | "error" }>(event.data);
    if (parsed) opts.onPluginNotice?.(parsed);
  });

  eventSource.addEventListener("plugin_status", (event: MessageEvent) => {
    const parsed = parseEvent<PluginStatusData>(event.data);
    if (parsed) opts.onPluginStatus?.(parsed);
  });

  eventSource.addEventListener("plugin_widget", (event: MessageEvent) => {
    const parsed = parseEvent<PluginWidgetData>(event.data);
    if (parsed) opts.onPluginWidget?.(parsed);
  });

  eventSource.addEventListener("plugin_composer_text", (event: MessageEvent) => {
    const parsed = parseEvent<{ text: string }>(event.data);
    if (parsed) opts.onPluginComposerText?.(parsed.text);
  });

  // ── Send queue ────────────────────────────────────────────────────────
  // Full snapshot on every change: the queue is small and merging deltas in
  // the client would be a second source of truth.
  if (opts.onQueueUpdate) {
    eventSource.addEventListener("queue_update", (event: MessageEvent) => {
      const parsed = parseEvent<{ messages?: Message[] }>(event.data);
      if (parsed) opts.onQueueUpdate!(parsed.messages ?? []);
    });
  }

  // ── Conversation changed outside this stream ──────────────────────────
  // A tool posted a message into this chat (chat_respond), or started a run in
  // it, without this client asking. The DB is the authority. reload.
  eventSource.addEventListener("messages_changed", () => {
    void opts.onReload();
  });

  // ── Token usage ───────────────────────────────────────────────────────
  if (opts.onTokenUsage) {
    eventSource.addEventListener("token_usage", (event: MessageEvent) => {
      const parsed = parseEvent<TokenUsage>(event.data);
      if (parsed) opts.onTokenUsage!(parsed);
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
      const parsed = parseEvent<{ summary?: string; tokensBefore?: number; aborted?: boolean }>(
        event.data,
      );
      if (!parsed) return;
      if (!parsed.aborted) {
        opts.onCompactionEnd!(parsed.summary, parsed.tokensBefore);
      } else {
        opts.onCompactionEnd!();
      }
    });
  }

  // ── Provider retry: a transient failure is being retried ─────────────
  if (opts.onRetryStart || opts.onRetryEnd) {
    eventSource.addEventListener("retry_start", (event: MessageEvent) => {
      markLoading();
      const parsed = parseEvent<{
        attempt: number;
        maxAttempts: number;
        delayMs: number;
        errorMessage: string;
      }>(event.data);
      if (parsed) opts.onRetryStart?.(parsed);
    });

    eventSource.addEventListener("retry_end", (event: MessageEvent) => {
      const parsed = parseEvent<{ success: boolean; attempt: number; finalError?: string }>(
        event.data,
      );
      if (parsed) opts.onRetryEnd?.(parsed);
    });
  }

  // ── Done: reload DB state, keep watching for the next generation ──────
  eventSource.addEventListener("done", () => {
    handleDone();
  });

  // ── Error (named SSE event only). terminal ───────────────────────────
  // addEventListener catches both named "error" SSE events (with JSON data)
  // AND transport-level errors (empty data). Only events with data are real
  // errors. transport errors are handled by onerror below.
  eventSource.addEventListener("error", (event: MessageEvent) => {
    if (!event.data) return; // Transport error. handled by onerror

    const parsed = parseEvent<{ message?: string }>(event.data);
    const message = parsed?.message || "Stream error";
    console.error("Stream error:", message);
    opts.onStreamError?.(message);

    // Terminal. close the connection (do NOT let the browser retry-loop on
    // persistent errors).
    eventSource.close();
    opts.eventSourceRef.current = null;
    handleDone();
  });

  // ── Transport error. the browser auto-reconnects with Last-Event-ID and
  //    the server replays buffered events, so we don't need to do anything.
  eventSource.onerror = () => {
    // Auto-reconnect handled by the browser.
  };
}
