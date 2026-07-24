"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { GlassPanel } from "@/components/ui/glass-panel";
import { MessageList } from "./message-list";
import { InputBar } from "./input-bar";
import { fetchJson, patchJson } from "@/lib/http";
import { useStreamingSessions } from "@/hooks/use-streaming-sessions";
import { DEFAULT_TOOL_CONFIG, type ToolConfig } from "@/lib/pi/tool-config";
import type { Message, ApprovalData } from "./types";
import { ChatHeader } from "./chat-header";
import { useTypingAnimation } from "./use-typing-animation";
import { useChatStream } from "./use-chat-stream";
import { buildTurnMessage, finalizeStreaming, type StreamingState } from "./chat-streaming-state";
import type { TokenUsage } from "./input-bar";

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
    current: { text: "", thinking: "", toolCalls: [] },
    displayText: "",
    displayThinking: "",
  });

  // Source of truth for streaming state — updated synchronously in event handlers.
  const streamingRef = useRef<StreamingState>(streaming);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Session state (declared before useChatStream so setters are available)
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalData[]>([]);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const { streamingIds, markStreaming, markDone } = useStreamingSessions();

  // Shared stream orchestration (SSE setup, reconnection, approval handling)
  const { startReconnection, connectStream, closeEventSource, resetStreaming } = useChatStream(
    sessionId,
    streamingRef,
    eventSourceRef,
    setStreaming,
    setMessages,
    setIsLoading,
    setPendingApprovals,
    markDone,
    setTokenUsage,
    () => setIsCompacting(true),
    () => setIsCompacting(false),
  );

  // Typing animation — smooth, buffer-based text playback
  useTypingAnimation(isLoading, setStreaming, streamingRef);

  // ─── Session state ───────────────────────────────────────────────────────

  const [sessionTitle, setSessionTitle] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [modelId, setModelId] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("off");
  const [toolConfig, setToolConfig] = useState<ToolConfig>(DEFAULT_TOOL_CONFIG);

  // ─── Data loading ────────────────────────────────────────────────────────

  const abortRef = useRef<AbortController | null>(null);

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

  const countAssistantMessages = useCallback(() => {
    return messages.filter((m) => m.role === "assistant").length;
  }, [messages]);

  // ─── Message handlers ────────────────────────────────────────────────────

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

      const assistantCountBefore = countAssistantMessages();
      resetStreaming();

      const abortController = new AbortController();
      abortRef.current = abortController;

      try {
        let res: Response;

        if (files && files.length > 0) {
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
          res = await fetch(`/api/chat/sessions/${sessionId}/messages`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content }),
          });
        }

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          if (res.status === 404) {
            router.push("/dashboard/chat");
            return;
          }
          if (res.status === 409) {
            setMessages((prev) => prev.filter((m) => !m.id.startsWith("temp-")));
            void loadMessages();
            startReconnection(
              () => loadMessages(),
              () => loadSessionTitle(),
            );
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

        const eventSource = connectStream(data.streamUrl, assistantCountBefore);

        // Override the default onDone to also clear loading (connectStream sets it,
        // but we need the DB reload after streaming completes for send flow)
        eventSource.addEventListener("done", () => {
          // finalizeStreaming is already called by connectStream
          // We just need to make sure loading is cleared
          // (connectStream's onDone already handles this)
        });

        eventSource.addEventListener("error", (event: MessageEvent) => {
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
        });
      } catch (err) {
        setIsLoading(false);
        console.error("Send error:", err);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, router, countAssistantMessages, resetStreaming, connectStream, startReconnection],
  );

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

        void loadMessages();
        const assistantCountBefore = countAssistantMessages();

        connectStream(data.streamUrl, assistantCountBefore);
      } catch (err) {
        setIsLoading(false);
        if (
          err instanceof Error &&
          "status" in err &&
          (err as { status?: number }).status === 409
        ) {
          void loadMessages();
          startReconnection(
            () => loadMessages(),
            () => loadSessionTitle(),
          );
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, countAssistantMessages, connectStream, startReconnection],
  );

  const handleStop = useCallback(() => {
    closeEventSource();
    fetch(`/api/chat/sessions/${sessionId}/stop`, { method: "POST" }).catch((err) => {
      console.error("Failed to call stop endpoint:", err);
    });
    finalizeStreaming(streamingRef.current, setMessages);
    setIsLoading(false);
  }, [sessionId, closeEventSource, streamingRef, setMessages]);

  // ─── Effects ─────────────────────────────────────────────────────────────

  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    const init = async () => {
      const sessionInfo = await loadMessages();
      loadSessionTitle();

      const wasStreaming = streamingIds.has(sessionId);
      const isProcessing = sessionInfo?.processingSince != null;

      if (!wasStreaming && !isProcessing) return;

      startReconnection(
        () => loadMessages(),
        () => loadSessionTitle(),
      );
    };

    init();

    return () => {
      closeEventSource();
    };
  }, [sessionId]);
  /* eslint-enable react-hooks/exhaustive-deps */

  // Temporary session auto-delete on unmount
  const temporaryRef = useRef(temporaryMode);
  const loadingRef = useRef(isLoading);
  const mountTimeRef = useRef(0);

  useEffect(() => {
    mountTimeRef.current = Date.now();
  }, []);

  useEffect(() => {
    temporaryRef.current = temporaryMode;
  }, [temporaryMode]);

  useEffect(() => {
    loadingRef.current = isLoading;
  }, [isLoading]);

  useEffect(() => {
    if (isLoading) {
      markStreaming(sessionId);
    } else {
      markDone(sessionId);
    }
  }, [isLoading, sessionId, markStreaming, markDone]);

  useEffect(() => {
    const mountedAt = mountTimeRef.current;
    return () => {
      const mountedFor = Date.now() - mountedAt;
      if (mountedFor < 1000) return;
      if (!temporaryRef.current || loadingRef.current) return;

      const url = `${window.location.origin}/api/chat/sessions/${sessionId}`;
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new URLSearchParams({ _method: "DELETE" }));
      } else {
        void fetch(url, { method: "DELETE" });
      }
    };
  }, [sessionId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      closeEventSource();
      abortRef.current?.abort();
    };
  }, [closeEventSource]);

  // ─── Title & settings ────────────────────────────────────────────────────

  const handleSaveTitle = useCallback(
    async (newTitle: string) => {
      const sanitized = newTitle.replace(/\0/g, "").slice(0, 50).trim();
      if (!sanitized) return;
      setSessionTitle(sanitized);
      setEditingTitle(false);
      try {
        await patchJson(`/api/chat/sessions/${sessionId}`, { title: sanitized });
        window.dispatchEvent(new CustomEvent("chat-renamed"));
      } catch (err) {
        console.error("Failed to save session title:", err);
      }
    },
    [sessionId],
  );

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

  // Persist model/thinking changes (debounced)
  const prevModelIdRef = useRef(modelId);
  const prevThinkingLevelRef = useRef(thinkingLevel);

  useEffect(() => {
    if (!modelId && thinkingLevel === "off") return;
    if (modelId === prevModelIdRef.current && thinkingLevel === prevThinkingLevelRef.current)
      return;

    const saveTimer = setTimeout(async () => {
      const [provider, ...modelParts] = modelId.split("/");
      try {
        await patchJson(`/api/chat/sessions/${sessionId}`, {
          modelProvider: provider || undefined,
          modelName: modelParts.join("/") || undefined,
          thinkingLevel,
        });
      } catch (err) {
        console.error("Failed to persist model/thinking settings:", err);
      }
    }, 300);
    return () => clearTimeout(saveTimer);
  }, [modelId, thinkingLevel, sessionId]);

  useEffect(() => {
    prevModelIdRef.current = modelId;
    prevThinkingLevelRef.current = thinkingLevel;
  });

  // ─── Display messages (streaming turns + DB messages) ────────────────────

  const displayMessages = [...messages];
  if (isLoading) {
    const hasContent =
      streaming.turns.length > 0 ||
      streaming.current.text ||
      streaming.current.thinking ||
      streaming.current.toolCalls.length > 0;

    if (hasContent) {
      for (let i = 0; i < streaming.turns.length; i++) {
        const turn = streaming.turns[i]!;
        displayMessages.push(
          buildTurnMessage(turn, `streaming-turn-${i}`, i > 0 ? `streaming-turn-0` : undefined),
        );
      }

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

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <>
      <GlassPanel className="flex flex-1 flex-col overflow-hidden border-0">
        <ChatHeader
          sessionTitle={sessionTitle}
          editingTitle={editingTitle}
          titleDraft={titleDraft}
          temporaryMode={temporaryMode}
          isLoading={isLoading}
          sessionId={sessionId}
          modelId={modelId}
          thinkingLevel={thinkingLevel}
          onTitleChange={setTitleDraft}
          onStartEditing={() => {
            setEditingTitle(true);
            setTitleDraft(sessionTitle);
          }}
          onCancelEditing={() => {
            setEditingTitle(false);
            setTitleDraft(sessionTitle);
          }}
          onSaveTitle={handleSaveTitle}
          onModelChange={setModelId}
          onThinkingChange={setThinkingLevel}
        />

        <div className="flex min-h-0 flex-1 flex-col">
          <MessageList
            messages={displayMessages}
            isLoading={isLoading}
            onEditMessage={handleEditMessage}
            onSendMessage={(content) => handleSend(content)}
            pendingApprovals={pendingApprovals}
            onApprovalResolved={(toolCallId) => {
              setPendingApprovals((prev) => prev.filter((a) => a.toolCallId !== toolCallId));
            }}
            sessionId={sessionId}
          />
        </div>
      </GlassPanel>

      <InputBar
        onSend={handleSend}
        isLoading={isLoading}
        onStop={handleStop}
        toolConfig={toolConfig}
        onToggleTool={handleToggleTool}
        tokenUsage={tokenUsage}
        isCompacting={isCompacting}
      />
    </>
  );
}
