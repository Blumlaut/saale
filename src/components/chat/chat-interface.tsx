"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Input } from "@/components/ui/input";
import { MessageList } from "./message-list";
import { InputBar } from "./input-bar";
import { ModelPicker } from "@/components/shared/model-picker";
import { ThinkingSelector } from "./thinking-selector";
import { fetchJson, patchJson } from "@/lib/http";
import { useStreamingSessions } from "@/hooks/use-streaming-sessions";
import { Loader2, Settings2, ChevronDown, Ghost, Pencil } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DEFAULT_TOOL_CONFIG, type ToolConfig } from "@/lib/pi/tool-config";
import {
  feedBuffer,
  computePending,
  estimateInstantRate,
  stepAnimation,
  consumeFromBuffer,
  DEFAULT_CONFIG,
  type AnimationState,
} from "@/lib/pi/stream-animation";
import { ShareButton } from "./share-button";
import type { Message, ToolCallData } from "./types";
import type { Dispatch, SetStateAction } from "react";

interface TurnData {
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

interface StreamingState {
  turns: TurnData[];
  current: TurnData;
  /** Animated text shown to the user — lags behind current.text and catches up via rAF */
  displayText: string;
  /** Animated thinking shown to the user — lags behind current.thinking */
  displayThinking: string;
}

const emptyTurn = (): TurnData => ({
  text: "",
  thinking: "",
  toolCalls: [],
});

const EMPTY_DISPLAY = {
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
function collectAllTurns(state: StreamingState): TurnData[] {
  return [
    ...state.turns,
    ...(state.current.text || state.current.thinking || state.current.toolCalls.length > 0
      ? [{ ...state.current }]
      : []),
  ];
}

/** Build a display message from a single turn */
function buildTurnMessage(
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
function finalizeStreaming(
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
async function tryLoadFromDb(
  sessionId: string,
  messageCountBefore: number,
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
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

/**
 * Set up common SSE event listeners for streaming.
 *
 * CRITICAL: updates streamingRef synchronously alongside setStreaming.
 * This ensures streamingRef is NEVER stale when done/error fires.
 *
 * Handles: token, thinking, tool_start, tool_end, turn_end
 * Accepts callbacks for: done, error, onerror (connection failure)
 */
interface StreamCallbacks {
  onDone: (eventSource: EventSource, event: MessageEvent) => void;
  onError: (eventSource: EventSource, event: MessageEvent) => void;
  onConnectionError: (eventSource: EventSource) => void;
}

function setupStreamListeners(
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

export function ChatInterface({
  sessionId,
  temporaryMode,
}: {
  sessionId: string;
  temporaryMode: boolean;
}) {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [streaming, setStreaming] = useState<StreamingState>({
    turns: [],
    current: emptyTurn(),
    displayText: "",
    displayThinking: "",
  });

  // Source of truth for streaming state — updated synchronously in event handlers.
  // NEVER stale when done/error fires.
  const streamingRef = useRef<StreamingState>(streaming);

  // Typing animation — buffer-based approach for smooth, non-jerky playback.
  // SSE chunks feed into a buffer; the rAF loop consumes at a steady rate.
  // Rate is estimated from SSE arrival patterns but preserved during gaps.
  const animFrameRef = useRef<number | null>(null);
  const animStateRef = useRef<AnimationState>({
    textBuffer: "",
    thinkingBuffer: "",
    smoothedRate: 0,
    rateStartChars: 0,
    rateStartTime: 0,
    rateLastChars: 0,
    rateLastTime: 0,
    charsAccum: 0,
  });

  useEffect(() => {
    if (!isLoading) {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
      animStateRef.current = {
        textBuffer: "",
        thinkingBuffer: "",
        smoothedRate: 0,
        rateStartChars: 0,
        rateStartTime: 0,
        rateLastChars: 0,
        rateLastTime: 0,
        charsAccum: 0,
      };
      return;
    }

    const config = DEFAULT_CONFIG;
    let lastInstantRate = 0;
    // Track cumulative chars to detect when new SSE data arrives.
    // feedBuffer (rate tracking) is ONLY called when cumulative changes.
    let lastCumulative = 0;

    const step = () => {
      setStreaming((prev) => {
        const cumulative = prev.current.text.length + prev.current.thinking.length;
        const hasNewData = cumulative !== lastCumulative;
        lastCumulative = cumulative;

        let animState = animStateRef.current;

        // Only update rate tracking when new SSE data arrives.
        // Calling feedBuffer every frame poisons the rate window with
        // zero-delta entries (same cumulative, advancing time).
        if (hasNewData) {
          const now = Date.now();
          animState = feedBuffer(
            animState,
            prev.current.text,
            prev.current.thinking,
            prev.displayText.length,
            prev.displayThinking.length,
            now,
          );

          // Estimate instant rate from SSE arrival patterns.
          const instantRate = estimateInstantRate(animState);
          if (instantRate > 0) {
            lastInstantRate = instantRate;
          }
        }

        // Recompute buffers every frame (display cursor advances independently).
        const pending = computePending(
          prev.current.text,
          prev.current.thinking,
          prev.displayText.length,
          prev.displayThinking.length,
        );
        animState = {
          ...animState,
          textBuffer: pending.textPending,
          thinkingBuffer: pending.thinkingPending,
        };

        // Step the animation — compute chars to display this frame.
        // Pass lastInstantRate (preserved during SSE gaps) for smooth playback.
        const animStep = stepAnimation(animState, config, lastInstantRate);

        // Store updated state (rate tracking + consumed buffers)
        animStateRef.current = consumeFromBuffer(
          animState,
          animStep.textChars,
          animStep.thinkingChars,
        );

        const next = {
          ...prev,
          displayText: prev.current.text.slice(0, prev.displayText.length + animStep.textChars),
          displayThinking: prev.current.thinking.slice(
            0,
            prev.displayThinking.length + animStep.thinkingChars,
          ),
        };
        streamingRef.current = next;
        animFrameRef.current = requestAnimationFrame(step);
        return next;
      });
    };

    animFrameRef.current = requestAnimationFrame(step);

    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
    };
  }, [isLoading]);

  const [sessionTitle, setSessionTitle] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [modelId, setModelId] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("off");
  const [toolConfig, setToolConfig] = useState<ToolConfig>(DEFAULT_TOOL_CONFIG);
  const { streamingIds, markStreaming, markDone } = useStreamingSessions();
  const temporaryRef = useRef(temporaryMode);
  const loadingRef = useRef(isLoading);
  const prevLoadingRef = useRef(isLoading);
  const mountTimeRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const loadMessages = async (): Promise<{ processingSince?: string } | null> => {
    try {
      const data = await fetchJson<{
        messages: Message[];
        session: {
          modelProvider?: string;
          modelName?: string;
          thinkingLevel?: string;
          toolConfig?: ToolConfig;
          processingSince?: string;
        };
      }>(`/api/chat/sessions/${sessionId}/messages`);
      setMessages(data.messages);
      if (data.session) {
        const modelStr =
          data.session.modelProvider && data.session.modelName
            ? `${data.session.modelProvider}/${data.session.modelName}`
            : "";
        if (modelStr) setModelId(modelStr);
        if (data.session.thinkingLevel) setThinkingLevel(data.session.thinkingLevel);
        if (data.session.toolConfig) {
          setToolConfig({ ...DEFAULT_TOOL_CONFIG, ...data.session.toolConfig });
        }
      }
      return data.session ?? null;
    } catch (err) {
      // Session was deleted (e.g. temporary chat closed elsewhere) — redirect
      if (err instanceof Error && "status" in err && (err as { status?: number }).status === 404) {
        router.push("/dashboard/chat");
        return null;
      }
      return null;
    }
  };

  const loadSessionTitle = async () => {
    try {
      const data = await fetchJson<{ session: { title: string } }>(
        `/api/chat/sessions/${sessionId}`,
      );
      if (data.session?.title) {
        setSessionTitle(data.session.title);
      }
    } catch (err) {
      console.error("Failed to load session title:", err);
    }
  };

  // Count assistant messages (for DB poll comparison after streaming)
  const countAssistantMessages = useCallback(() => {
    return messages.filter((m) => m.role === "assistant").length;
  }, [messages]);

  // Recovery: when user refreshes during generation, reconnect via SSE.
  // The stream endpoint subscribes to Redis pub/sub and forwards live events.
  // Shared between mount effect and 409 handlers.
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startReconnection = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
    }

    setIsLoading(true);
    markStreaming(sessionId);
    const initState = { turns: [], current: emptyTurn(), ...EMPTY_DISPLAY };
    setStreaming(initState);
    streamingRef.current = initState;

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

    // Set up common stream listeners
    setupStreamListeners(eventSource, setStreaming, streamingRef, {
      onDone: () => {
        cleanup();
        // Safety net: finalize streamed content into messages
        finalizeStreaming(streamingRef.current, setMessages);
        setIsLoading(false);
        // Reload from DB to get canonical state
        loadMessages();
        markDone(sessionId);
      },
      onError: () => {
        cleanup();
        // Safety net: finalize streamed content
        finalizeStreaming(streamingRef.current, setMessages);
        setIsLoading(false);
        markDone(sessionId);
      },
      onConnectionError: () => {
        cleanup();
        // Safety net: finalize streamed content
        finalizeStreaming(streamingRef.current, setMessages);
        setIsLoading(false);
        markDone(sessionId);
      },
    });

    // Resume event: backend DB polling detected generation is done.
    eventSource.addEventListener("resume", () => {
      cleanup();
      setIsLoading(false);
      loadMessages();
      markDone(sessionId);
    });

    // Safety timeout — if still loading after 15s, force-clear and reload from DB.
    // This catches cases where the SSE stream never emits done (backend bug, Redis failure).
    reconnectTimerRef.current = setTimeout(() => {
      cleanup();
      // Safety net: finalize streamed content
      finalizeStreaming(streamingRef.current, setMessages);
      setIsLoading(false);
      loadMessages();
      markDone(sessionId);
    }, 15_000);

    // Fallback: poll the DB during reconnection. If generation finishes before SSE
    // events arrive (buffer empty, pub/sub failure, etc.), pick up the result from DB.
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
            await loadMessages();
            markDone(sessionId);
          }
        }
      } catch (err) {
        console.error("Reconnection DB poll error:", err);
      }
    }, 3000);
  }, [sessionId, markStreaming, markDone]); // eslint-disable-line react-hooks/exhaustive-deps

  // Edit a user message — updates in place, deletes messages after, streams new response
  const handleEditMessage = useCallback(
    async (messageId: string, newContent: string) => {
      setIsLoading(true);
      try {
        const data = await patchJson<{
          ok: boolean;
          messageId: string;
          streamUrl: string;
        }>(`/api/chat/sessions/${sessionId}/messages/${messageId}`, {
          content: newContent,
        });

        // Reload messages to reflect the edit + deletion of messages after
        loadMessages();

        // Capture assistant count before streaming starts
        const assistantCountBefore = countAssistantMessages();

        // Connect to stream for new AI response
        const initState = { turns: [], current: emptyTurn(), ...EMPTY_DISPLAY };
        setStreaming(initState);
        streamingRef.current = initState;

        const eventSource = new EventSource(data.streamUrl);
        eventSourceRef.current = eventSource;

        const cleanup = () => {
          eventSource.close();
          eventSourceRef.current = null;
        };

        setupStreamListeners(eventSource, setStreaming, streamingRef, {
          onDone: () => {
            cleanup();
            // Safety net: finalize streamed content into messages
            finalizeStreaming(streamingRef.current, setMessages);
            setIsLoading(false);
            // Poll DB until messages are saved (prevents flash of blank)
            void tryLoadFromDb(sessionId, assistantCountBefore, setMessages);
          },
          onError: () => {
            cleanup();
            // Safety net: finalize streamed content
            finalizeStreaming(streamingRef.current, setMessages);
            setIsLoading(false);
          },
          onConnectionError: () => {
            cleanup();
            // Safety net: finalize streamed content
            finalizeStreaming(streamingRef.current, setMessages);
            setIsLoading(false);
          },
        });
      } catch (err) {
        setIsLoading(false);
        if (
          err instanceof Error &&
          "status" in err &&
          (err as { status?: number }).status === 409
        ) {
          // Response already in progress — reload and reconnect
          loadMessages();
          startReconnection();
        }
      }
    },
    [sessionId, countAssistantMessages], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Load messages and session title.
  // If processingSince is set (user refreshed during processing), reconnect via SSE.
  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    const init = async () => {
      const sessionInfo = await loadMessages();
      loadSessionTitle();

      const wasStreaming = streamingIds.has(sessionId);
      const isProcessing = sessionInfo?.processingSince != null;

      if (!wasStreaming && !isProcessing) return;

      startReconnection();
    };

    init();

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [sessionId]);
  /* eslint-enable react-hooks/exhaustive-deps */

  // Record mount time on first render
  useEffect(() => {
    mountTimeRef.current = Date.now();
  }, []);

  // Keep refs in sync for auto-delete cleanup
  useEffect(() => {
    temporaryRef.current = temporaryMode;
  }, [temporaryMode]);

  useEffect(() => {
    loadingRef.current = isLoading;
    if (isLoading) {
      markStreaming(sessionId);
    } else if (prevLoadingRef.current) {
      // Was loading, now done — trigger pop animation
      markDone(sessionId);
    }
    prevLoadingRef.current = isLoading;
  }, [isLoading, sessionId, markStreaming, markDone]);

  // Auto-delete temporary sessions on unmount only (not on dep changes)
  // Grace period prevents StrictMode double-mount from deleting instantly
  useEffect(() => {
    const mountedAt = mountTimeRef.current;
    return () => {
      const mountedFor = Date.now() - mountedAt;
      if (mountedFor < 1000) return; // StrictMode double-mount guard
      if (!temporaryRef.current || loadingRef.current) return;

      // Use sendBeacon for reliable delivery on page unload/refresh,
      // fallback to fetch for in-app navigation
      const url = `${window.location.origin}/api/chat/sessions/${sessionId}`;
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new URLSearchParams({ _method: "DELETE" }));
      } else {
        void fetch(url, { method: "DELETE" });
      }
    };
  }, [sessionId]); // sessionId stable per mount — cleanup fires only on unmount

  // Save the session title
  const handleSaveTitle = useCallback(
    async (newTitle: string) => {
      const sanitized = newTitle.replace(/\0/g, "").slice(0, 50).trim();
      if (!sanitized) return;
      setSessionTitle(sanitized);
      setEditingTitle(false);
      try {
        await patchJson(`/api/chat/sessions/${sessionId}`, { title: sanitized });
        // Notify sidebar to refresh
        window.dispatchEvent(new CustomEvent("chat-renamed"));
      } catch (err) {
        console.error("Failed to save session title:", err);
      }
    },
    [sessionId],
  );

  // Toggle a tool category and persist
  const handleToggleTool = useCallback(
    async (category: keyof ToolConfig) => {
      const updated = { ...toolConfig, [category]: !toolConfig[category] };
      setToolConfig(updated);

      try {
        await patchJson(`/api/chat/sessions/${sessionId}`, { toolConfig: updated });
      } catch (err) {
        console.error("Failed to save tool config:", err);
      }
    },
    [toolConfig, sessionId],
  );

  // Send message
  const handleSend = useCallback(
    async (content: string, files?: File[]) => {
      const userMsg: Message = {
        id: `temp-${Date.now()}`,
        role: "user",
        content,
        thinking: undefined,
        toolCalls: undefined,
        parentMessageId: undefined,
        createdAt: new Date().toISOString(),
        // Temp attachments from local files (preview URLs)
        attachments:
          files?.map((f) => ({
            id: `temp-${f.name}-${f.size}`,
            storageId: `temp-${f.name}`,
            fileName: f.name,
            mimeType: f.type,
            size: f.size,
          })) ?? undefined,
      };
      setMessages((prev) => [...prev, userMsg]);
      setIsLoading(true);

      // Capture assistant count before streaming starts (for DB poll comparison)
      const assistantCountBefore = countAssistantMessages();

      // Reset streaming state
      const initState = { turns: [], current: emptyTurn(), ...EMPTY_DISPLAY };
      setStreaming(initState);
      streamingRef.current = initState;

      const abortController = new AbortController();
      abortRef.current = abortController;

      try {
        let res: Response;

        if (files && files.length > 0) {
          // Multipart form data for messages with images
          const formData = new FormData();
          formData.append("content", content);
          for (const file of files) {
            formData.append("files", file);
          }
          res = await fetch(`/api/chat/sessions/${sessionId}/messages`, {
            method: "POST",
            body: formData,
          });
        } else {
          // Plain JSON for text-only messages
          res = await fetch(`/api/chat/sessions/${sessionId}/messages`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content }),
          });
        }

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          if (res.status === 404) {
            // Session was deleted (temporary chat closed) — redirect
            router.push("/dashboard/chat");
            return;
          }
          if (res.status === 409) {
            // Response already in progress — remove temp message and reconnect
            setMessages((prev) => prev.filter((m) => !m.id.startsWith("temp-")));
            loadMessages();
            startReconnection();
            return;
          }
          throw new Error(`Failed to send message: ${body.error || res.statusText}`);
        }

        const data = await res.json();

        if (data.message) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id.startsWith("temp-")
                ? {
                    ...m,
                    id: data.message.id,
                    createdAt: data.message.createdAt,
                    attachments: data.message.attachments?.length
                      ? data.message.attachments
                      : undefined,
                  }
                : m,
            ),
          );
        }

        const eventSource = new EventSource(data.streamUrl);
        eventSourceRef.current = eventSource;

        setupStreamListeners(eventSource, setStreaming, streamingRef, {
          onDone: () => {
            eventSource.close();
            eventSourceRef.current = null;

            // Safety net: finalize streamed content into messages array.
            // This ensures the reply is NEVER lost — even if DB reload fails.
            finalizeStreaming(streamingRef.current, setMessages);

            // Clear loading — streaming display will be replaced by finalized messages
            setIsLoading(false);

            // Poll DB to replace temp messages with canonical DB versions.
            // Only replaces if DB has more assistant messages (prevents flash of blank).
            void tryLoadFromDb(sessionId, assistantCountBefore, setMessages);
          },
          onError: (_es, event) => {
            eventSource.close();
            eventSourceRef.current = null;

            // Safety net: finalize streamed content
            finalizeStreaming(streamingRef.current, setMessages);
            setIsLoading(false);

            const parsed = JSON.parse(event.data);
            if (parsed.message?.includes("No AI model configured")) {
              toast.error("No AI model configured", {
                description: "Select a default model in Settings > AI & Models to start chatting.",
                action: {
                  label: "Open Settings",
                  onClick: () => router.push("/dashboard/settings"),
                },
              });
            }

            setMessages((prev) => [
              ...prev,
              {
                id: `error-${Date.now()}`,
                role: "assistant" as const,
                content: `Error: ${parsed.message || "Something went wrong"}`,
                thinking: undefined,
                toolCalls: undefined,
                parentMessageId: undefined,
                createdAt: new Date().toISOString(),
                attachments: undefined,
              },
            ]);
          },
          onConnectionError: () => {
            eventSource.close();
            eventSourceRef.current = null;

            // Safety net: finalize streamed content
            finalizeStreaming(streamingRef.current, setMessages);
            setIsLoading(false);
          },
        });
      } catch (err) {
        setIsLoading(false);
        console.error("Send error:", err);
      }
    },
    [sessionId, router, countAssistantMessages], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Stop streaming — explicitly cancel the generation on the backend.
  const handleStop = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    // Tell backend to abort the LLM and clear processingSince
    fetch(`/api/chat/sessions/${sessionId}/stop`, { method: "POST" }).catch((err) => {
      console.error("Failed to call stop endpoint:", err);
    });
    // Safety net: finalize streamed content
    finalizeStreaming(streamingRef.current, setMessages);
    setIsLoading(false);
  }, [sessionId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, []);

  // Track previous values to avoid sending PATCH on every session switch
  const prevModelIdRef = useRef(modelId);
  const prevThinkingLevelRef = useRef(thinkingLevel);

  // Persist model/thinking changes to the session (only when values actually change)
  useEffect(() => {
    if (!modelId && thinkingLevel === "off") return;
    if (modelId === prevModelIdRef.current && thinkingLevel === prevThinkingLevelRef.current)
      return;

    const saveTimer = setTimeout(async () => {
      const [provider, ...modelParts] = modelId.split("/");
      const modelName = modelParts.join("/");
      try {
        await patchJson(`/api/chat/sessions/${sessionId}`, {
          modelProvider: provider || undefined,
          modelName: modelName || undefined,
          thinkingLevel,
        });
      } catch (err) {
        console.error("Failed to persist model/thinking settings:", err);
      }
    }, 300);
    return () => clearTimeout(saveTimer);
  }, [modelId, thinkingLevel, sessionId]);

  // Keep refs in sync (runs after the persist effect)
  useEffect(() => {
    prevModelIdRef.current = modelId;
    prevThinkingLevelRef.current = thinkingLevel;
  });

  // Build display messages (including streaming turns)
  const displayMessages = [...messages];
  if (isLoading) {
    const hasContent =
      streaming.turns.length > 0 ||
      streaming.current.text ||
      streaming.current.thinking ||
      streaming.current.toolCalls.length > 0;

    if (hasContent) {
      // Add completed turns as separate messages
      for (let i = 0; i < streaming.turns.length; i++) {
        const turn = streaming.turns[i]!;
        displayMessages.push(
          buildTurnMessage(turn, `streaming-turn-${i}`, i > 0 ? `streaming-turn-0` : undefined),
        );
      }

      // Add current in-progress turn — use animated display values for smooth typing
      if (
        streaming.current.text ||
        streaming.current.thinking ||
        streaming.current.toolCalls.length > 0
      ) {
        displayMessages.push(
          buildTurnMessage(
            {
              ...streaming.current,
              text: streaming.displayText,
              thinking: streaming.displayThinking,
            },
            "streaming-current",
            streaming.turns.length > 0 ? `streaming-turn-0` : undefined,
          ),
        );
      }
    }
  }

  return (
    <>
      {/* Scrollable message area — fills all available space */}
      <GlassPanel className="flex flex-1 flex-col overflow-hidden border-0">
        {/* Header */}
        <div className="border-border/30 flex items-center gap-2 border-b px-4 py-3 md:px-5 md:py-3">
          {/* Editable session title */}
          {editingTitle ? (
            <Input
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value.slice(0, 50))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleSaveTitle(titleDraft);
                } else if (e.key === "Escape") {
                  setEditingTitle(false);
                  setTitleDraft(sessionTitle);
                }
              }}
              onBlur={() => handleSaveTitle(titleDraft)}
              autoFocus
              className="h-6 w-40 text-sm font-semibold"
            />
          ) : (
            <button
              onClick={() => {
                setEditingTitle(true);
                setTitleDraft(sessionTitle);
              }}
              className="group/title -ml-1 flex items-center gap-1 rounded px-1 py-0.5 text-sm font-semibold transition-colors hover:bg-white/10 dark:hover:bg-white/5"
            >
              <span className="max-w-[200px] truncate md:max-w-[300px]">
                {sessionTitle || "Chat"}
              </span>
              <Pencil className="text-muted-foreground h-3 w-3 opacity-0 transition-opacity group-hover/title:opacity-70" />
            </button>
          )}
          {temporaryMode && (
            <span className="text-muted-foreground flex items-center gap-1 text-xs">
              <Ghost className="h-3 w-3" />
              temporary
            </span>
          )}
          {isLoading && <Loader2 className="text-muted-foreground h-3.5 w-3.5 animate-spin" />}

          {/* Share button */}
          <ShareButton sessionId={sessionId} />

          {/* Model & thinking selectors — inline on desktop, dropdown on mobile */}
          <div className="ml-auto flex items-center gap-1">
            {/* Desktop: show selectors directly */}
            <div className="hidden items-center gap-1 md:flex">
              <ModelPicker value={modelId} onChange={setModelId} />
              <ThinkingSelector value={thinkingLevel} onChange={setThinkingLevel} />
            </div>
            {/* Mobile: compact dropdown */}
            <div className="md:hidden">
              <DropdownMenu>
                <DropdownMenuTrigger>
                  <span className="inline-flex h-7 items-center gap-1 rounded px-1.5 text-sm transition-colors hover:bg-white/10 dark:hover:bg-white/5">
                    <Settings2 className="h-3.5 w-3.5" />
                    <ChevronDown className="h-3 w-3" />
                  </span>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <div className="px-2 pt-1.5 pb-1">
                    <ModelPicker value={modelId} onChange={setModelId} compact />
                  </div>
                  <div className="border-border/50 border-t px-2 pt-1.5 pb-1">
                    <ThinkingSelector value={thinkingLevel} onChange={setThinkingLevel} />
                  </div>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>

        {/* Messages — flex-1 fills panel, scrolls internally */}
        <MessageList
          messages={displayMessages}
          isLoading={isLoading}
          onEditMessage={handleEditMessage}
          onSendMessage={(content) => handleSend(content)}
        />
      </GlassPanel>

      {/* Input bar — outside the panel, always visible */}
      <InputBar
        onSend={handleSend}
        isLoading={isLoading}
        onStop={handleStop}
        toolConfig={toolConfig}
        onToggleTool={handleToggleTool}
      />
    </>
  );
}
