"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
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
import type { Message, ToolCallData } from "./types";

interface TurnData {
  text: string;
  thinking: string;
  toolCalls: Array<{
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    status: "running" | "completed" | "error";
    result?: string;
    error?: string;
  }>;
}

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

/** Finalize streaming state by adding all turns as messages */
function finalizeStreaming(
  streamingRef: React.RefObject<StreamingState>,
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
) {
  const allTurns = collectAllTurns(streamingRef.current);
  if (allTurns.length > 0) {
    const baseId = `assistant-turn-${Date.now()}`;
    setMessages((prev) => [...prev, ...buildAssistantMessages(allTurns, baseId)]);
  }
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

interface StreamingState {
  /** Completed turns (finalized from turn_end events) */
  turns: TurnData[];
  /** Current in-progress turn data */
  current: TurnData;
}

const emptyTurn = (): TurnData => ({
  text: "",
  thinking: "",
  toolCalls: [],
});

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
  });
  const streamingRef = useRef<StreamingState>(streaming);
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

  const loadMessages = async () => {
    try {
      const data = await fetchJson<{
        messages: Message[];
        session: {
          modelProvider?: string;
          modelName?: string;
          thinkingLevel?: string;
          toolConfig?: ToolConfig;
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
    } catch (err) {
      // Session was deleted (e.g. temporary chat closed elsewhere) — redirect
      if (err instanceof Error && "status" in err && (err as { status?: number }).status === 404) {
        router.push("/dashboard/chat");
        return;
      }
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
    } catch {
      // Ignore
    }
  };

  // Keep streamingRef in sync
  useEffect(() => {
    streamingRef.current = streaming;
  }, [streaming]);

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

        // Connect to stream for new AI response
        setStreaming({ turns: [], current: emptyTurn() });

        const eventSource = new EventSource(data.streamUrl);
        eventSourceRef.current = eventSource;

        const cleanup = () => {
          eventSource.close();
          eventSourceRef.current = null;
        };

        eventSource.addEventListener("token", (event: MessageEvent) => {
          const parsed = JSON.parse(event.data);
          setStreaming((prev) => ({
            ...prev,
            current: { ...prev.current, text: parsed.text },
          }));
        });

        eventSource.addEventListener("thinking", (event: MessageEvent) => {
          const parsed = JSON.parse(event.data);
          setStreaming((prev) => ({
            ...prev,
            current: { ...prev.current, thinking: parsed.thinking },
          }));
        });

        eventSource.addEventListener("tool_start", (event: MessageEvent) => {
          const parsed = JSON.parse(event.data);
          setStreaming((prev) => ({
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
                },
              ],
            },
          }));
        });

        eventSource.addEventListener("tool_end", (event: MessageEvent) => {
          const parsed = JSON.parse(event.data);
          setStreaming((prev) => ({
            ...prev,
            current: {
              ...prev.current,
              toolCalls: prev.current.toolCalls.map((tc) =>
                tc.toolCallId === parsed.toolCallId
                  ? {
                      ...tc,
                      status: parsed.isError ? ("error" as const) : ("completed" as const),
                      result: parsed.result,
                      error: parsed.isError ? parsed.result : undefined,
                    }
                  : tc,
              ),
            },
          }));
        });

        eventSource.addEventListener("turn_end", (event: MessageEvent) => {
          const parsed = JSON.parse(event.data);
          setStreaming((prev) => ({
            ...prev,
            turns: [
              ...prev.turns,
              {
                text: parsed.text || prev.current.text,
                thinking: parsed.thinking || prev.current.thinking,
                toolCalls:
                  parsed.toolCalls?.length > 0
                    ? parsed.toolCalls.map((tc: ToolCallData) => ({
                        toolCallId: tc.id,
                        toolName: tc.name,
                        args: tc.args,
                        status: tc.error ? "error" : "completed",
                        result: tc.result,
                      }))
                    : prev.current.toolCalls,
              },
            ],
            current: emptyTurn(),
          }));
        });

        eventSource.addEventListener("done", (event: MessageEvent) => {
          setIsLoading(false);
          cleanup();
          const allTurns = collectAllTurns(streamingRef.current);
          const parsed = JSON.parse(event.data);

          if (allTurns.length > 0) {
            const baseId = `assistant-turn-${Date.now()}`;
            setMessages((prev) => [...prev, ...buildAssistantMessages(allTurns, baseId)]);
          } else if (parsed.text || parsed.thinking || parsed.toolCalls?.length > 0) {
            const finalToolCalls: ToolCallData[] | undefined =
              parsed.toolCalls?.length > 0
                ? parsed.toolCalls.map((tc: ToolCallData) => ({
                    id: tc.id,
                    name: tc.name,
                    args: tc.args,
                    error: tc.error,
                    status: tc.status,
                    result: tc.result || undefined,
                  }))
                : undefined;

            setMessages((prev) => [
              ...prev,
              {
                id: `assistant-${Date.now()}`,
                role: "assistant" as const,
                content: parsed.text,
                thinking: parsed.thinking || undefined,
                toolCalls: finalToolCalls,
                parentMessageId: undefined,
                createdAt: new Date().toISOString(),
                attachments: undefined,
              },
            ]);
          }

          loadMessages();
        });

        eventSource.addEventListener("error", (event: MessageEvent) => {
          const parsed = JSON.parse(event.data);
          console.error("Stream error:", parsed);
          cleanup();
          setIsLoading(false);
        });

        eventSource.onerror = () => {
          cleanup();
          setIsLoading(false);
          finalizeStreaming(streamingRef, setMessages);
          loadMessages();
        };
      } catch {
        setIsLoading(false);
      }
    },
    [sessionId], // eslint-disable-line react-hooks/exhaustive-deps -- loadMessages is stable
  );

  // Load messages and session title.
  // If the session was streaming when we navigated away, poll for the response.
  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    const wasStreaming = streamingIds.has(sessionId);
    let pollInterval: ReturnType<typeof setInterval> | null = null;

    loadMessages();
    loadSessionTitle();

    if (!wasStreaming) return;

    // Delay check to let initial loadMessages() settle
    const checkTimer = setTimeout(async () => {
      try {
        const data = await fetchJson<{ messages: Message[] }>(
          `/api/chat/sessions/${sessionId}/messages`,
        );
        const lastMessage = data.messages[data.messages.length - 1];

        if (lastMessage && lastMessage.role === "assistant") {
          // Response already saved — update and clear streaming indicator
          setMessages(data.messages);
          markDone(sessionId);
          return;
        }

        // Response not yet saved — start polling
        setIsLoading(true);
        pollInterval = setInterval(async () => {
          try {
            const data = await fetchJson<{ messages: Message[] }>(
              `/api/chat/sessions/${sessionId}/messages`,
            );
            const lastMsg = data.messages[data.messages.length - 1];
            if (lastMsg && lastMsg.role === "assistant") {
              clearInterval(pollInterval!);
              pollInterval = null;
              setMessages(data.messages);
              setIsLoading(false);
              markDone(sessionId);
            }
          } catch {
            clearInterval(pollInterval!);
            pollInterval = null;
            setIsLoading(false);
          }
        }, 1500);
      } catch {
        // Session deleted — ignore
      }
    }, 500);

    return () => {
      clearTimeout(checkTimer);
      if (pollInterval) clearInterval(pollInterval);
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
      } catch {
        // Silently fail — local state is already updated
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
      } catch {
        // Silently fail — local state is already updated
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
      setStreaming({ turns: [], current: emptyTurn() });

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

        eventSource.addEventListener("token", (event: MessageEvent) => {
          const parsed = JSON.parse(event.data);
          setStreaming((prev) => ({
            ...prev,
            current: { ...prev.current, text: parsed.text },
          }));
        });

        eventSource.addEventListener("thinking", (event: MessageEvent) => {
          const parsed = JSON.parse(event.data);
          setStreaming((prev) => ({
            ...prev,
            current: { ...prev.current, thinking: parsed.thinking },
          }));
        });

        eventSource.addEventListener("tool_start", (event: MessageEvent) => {
          const parsed = JSON.parse(event.data);
          setStreaming((prev) => ({
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
                },
              ],
            },
          }));
        });

        eventSource.addEventListener("tool_end", (event: MessageEvent) => {
          const parsed = JSON.parse(event.data);
          setStreaming((prev) => ({
            ...prev,
            current: {
              ...prev.current,
              toolCalls: prev.current.toolCalls.map((tc) =>
                tc.toolCallId === parsed.toolCallId
                  ? {
                      ...tc,
                      status: parsed.isError ? ("error" as const) : ("completed" as const),
                      result: parsed.result,
                      error: parsed.isError ? parsed.result : undefined,
                    }
                  : tc,
              ),
            },
          }));
        });

        eventSource.addEventListener("turn_end", (event: MessageEvent) => {
          const parsed = JSON.parse(event.data);
          // Finalize the current turn and add it to completed turns
          setStreaming((prev) => ({
            ...prev,
            turns: [
              ...prev.turns,
              {
                text: parsed.text || prev.current.text,
                thinking: parsed.thinking || prev.current.thinking,
                toolCalls:
                  parsed.toolCalls?.length > 0
                    ? parsed.toolCalls.map((tc: ToolCallData) => ({
                        toolCallId: tc.id,
                        toolName: tc.name,
                        args: tc.args,
                        status: tc.error ? "error" : "completed",
                        result: tc.result,
                      }))
                    : prev.current.toolCalls,
              },
            ],
            current: emptyTurn(),
          }));
        });

        eventSource.addEventListener("done", (event: MessageEvent) => {
          setIsLoading(false);
          eventSource.close();
          eventSourceRef.current = null;

          // Finalize any remaining current turn
          const allTurns = collectAllTurns(streamingRef.current);

          // If we got turn_end events, use those. Otherwise create a single message from streaming state.
          const parsed = JSON.parse(event.data);

          if (allTurns.length > 0) {
            // Multi-turn response: add each turn as a separate message
            const baseId = `assistant-turn-${Date.now()}`;
            setMessages((prev) => [...prev, ...buildAssistantMessages(allTurns, baseId)]);
          } else if (parsed.text || parsed.thinking || parsed.toolCalls?.length > 0) {
            // Legacy single-turn fallback (from done event data)
            const finalToolCalls: ToolCallData[] | undefined =
              parsed.toolCalls?.length > 0
                ? parsed.toolCalls.map((tc: ToolCallData) => ({
                    id: tc.id,
                    name: tc.name,
                    args: tc.args,
                    error: tc.error,
                    status: tc.status,
                    result: tc.result || undefined,
                  }))
                : undefined;

            setMessages((prev) => [
              ...prev,
              {
                id: `assistant-${Date.now()}`,
                role: "assistant" as const,
                content: parsed.text,
                thinking: parsed.thinking || undefined,
                toolCalls: finalToolCalls,
                parentMessageId: undefined,
                createdAt: new Date().toISOString(),
                attachments: undefined,
              },
            ]);
          }
        });

        eventSource.addEventListener("error", (event: MessageEvent) => {
          const parsed = JSON.parse(event.data);
          console.error("Stream error:", parsed);
          eventSource.close();
          eventSourceRef.current = null;
          setIsLoading(false);
          // Add error message to chat
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
        });

        eventSource.onerror = () => {
          eventSource.close();
          eventSourceRef.current = null;
          setIsLoading(false);
          finalizeStreaming(streamingRef, setMessages);
        };
      } catch (err) {
        setIsLoading(false);
        console.error("Send error:", err);
      }
    },
    [sessionId, router],
  );

  // Stop streaming
  const handleStop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setIsLoading(false);
    finalizeStreaming(streamingRef, setMessages);
  }, []);

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

  // Persist model/thinking changes to the session
  useEffect(() => {
    if (!modelId && thinkingLevel === "off") return;
    const saveTimer = setTimeout(async () => {
      const [provider, ...modelParts] = modelId.split("/");
      const modelName = modelParts.join("/");
      try {
        await patchJson(`/api/chat/sessions/${sessionId}`, {
          modelProvider: provider || undefined,
          modelName: modelName || undefined,
          thinkingLevel,
        });
      } catch {
        // Silently fail
      }
    }, 300);
    return () => clearTimeout(saveTimer);
  }, [modelId, thinkingLevel, sessionId]);

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

      // Add current in-progress turn
      if (
        streaming.current.text ||
        streaming.current.thinking ||
        streaming.current.toolCalls.length > 0
      ) {
        displayMessages.push(
          buildTurnMessage(
            streaming.current,
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
