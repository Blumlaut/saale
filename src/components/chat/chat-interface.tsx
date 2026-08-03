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
import { useChatStream } from "./use-chat-stream";
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
  const eventSourceRef = useRef<EventSource | null>(null);

  // Session state
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalData[]>([]);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const { markStreaming, markDone } = useStreamingSessions();

  // ─── Session state ───────────────────────────────────────────────────────

  const [sessionTitle, setSessionTitle] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [modelId, setModelId] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("off");
  const [toolConfig, setToolConfig] = useState<ToolConfig>(DEFAULT_TOOL_CONFIG);

  // ─── Data loading ────────────────────────────────────────────────────────

  const abortRef = useRef<AbortController | null>(null);

  const loadMessages = useCallback(async (): Promise<{ isGenerating?: boolean } | null> => {
    try {
      const data = await fetchJson<{
        messages: Message[];
        session: {
          modelProvider?: string;
          modelName?: string;
          thinkingLevel?: string;
          toolConfig?: ToolConfig;
          isGenerating?: boolean;
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
  }, [sessionId, router]);

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

  // Shared stream orchestration (declared after the loaders it references).
  const { connect, disconnect } = useChatStream({
    sessionId,
    eventSourceRef,
    setMessages,
    setIsLoading,
    setPendingApprovals,
    markDone,
    onTokenUsage: setTokenUsage,
    onCompactionStart: () => setIsCompacting(true),
    onCompactionEnd: (summary?: string, tokensBefore?: number) => {
      setIsCompacting(false);
      if (summary) {
        setMessages((prev) => [
          ...prev,
          {
            id: `compaction-${Date.now()}`,
            role: "compaction" as const,
            content: summary,
            thinking: undefined,
            toolCalls: undefined,
            parentMessageId: undefined,
            createdAt: new Date().toISOString(),
            attachments: undefined,
            compaction: { tokensBefore: tokensBefore ?? 0 },
          },
        ]);
      }
    },
    onStreamError: (message) => {
      if (message.includes("No AI model configured")) {
        toast.error("No AI model configured", {
          description: "Select a default model in Settings > AI & Models to start chatting.",
          action: {
            label: "Open Settings",
            onClick: () => router.push("/dashboard/settings"),
          },
        });
      }
    },
    onReload: () => void loadMessages(),
  });

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
            // A generation is already running (another tab/session) — drop
            // the optimistic message and observe the live stream instead.
            setMessages((prev) => prev.filter((m) => !m.id.startsWith("temp-")));
            void loadMessages();
            connect();
            return;
          }
          throw new Error(`Failed to send message: ${body.error || res.statusText}`);
        }

        const data = await res.json();

        // Update temp user message with real ID
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

        // Connect to the SSE stream — the server prompts and streams events.
        connect();
      } catch (err) {
        setIsLoading(false);
        console.error("Send error:", err);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, router, connect, loadMessages, eventSourceRef],
  );

  const handleEditMessage = useCallback(
    async (messageId: string, newContent: string) => {
      setIsLoading(true);
      try {
        await patchJson<{
          ok: boolean;
          messageId: string;
          streamUrl: string;
        }>(`/api/chat/sessions/${sessionId}/messages/${messageId}`, {
          content: newContent,
        });

        void loadMessages();
        connect();
      } catch (err) {
        setIsLoading(false);
        if (
          err instanceof Error &&
          "status" in err &&
          (err as { status?: number }).status === 409
        ) {
          void loadMessages();
          connect();
        }
      }
    },
    [sessionId, connect, loadMessages],
  );

  const handleStop = useCallback(() => {
    fetch(`/api/chat/sessions/${sessionId}/stop`, { method: "POST" }).catch((err) => {
      console.error("Failed to call stop endpoint:", err);
    });
    // Keep the SSE connection open — the server aborts the agent, the
    // tracker publishes `done`, and this tab (plus every other observer)
    // reloads the final DB state.
  }, [sessionId]);

  const handleCompact = useCallback(() => {
    setIsCompacting(true);
    setTokenUsage(null);

    // Add optimistic compaction message so the user sees feedback immediately
    const optimisticId = `temp-compaction-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      {
        id: optimisticId,
        role: "compaction" as const,
        content: "",
        thinking: undefined,
        toolCalls: undefined,
        parentMessageId: undefined,
        createdAt: new Date().toISOString(),
        attachments: undefined,
        compaction: { tokensBefore: 0 },
      },
    ]);

    fetch(`/api/chat/sessions/${sessionId}/compact`, { method: "POST" })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          // Known conditions — show user-friendly toast
          if (data.error === "already_compacted") {
            toast.info("Already compacted", {
              description: "This conversation was already compacted.",
            });
          } else if (data.error === "nothing_to_compact") {
            toast.info("Nothing to compact", {
              description: "The conversation is too short to compact.",
            });
          } else {
            toast.error("Compaction failed", {
              description: data.message || "Something went wrong.",
            });
          }
          throw new Error(data.message || "Compact failed");
        }

        return data;
      })
      .then(() => {
        void loadMessages();
      })
      .catch((err) => {
        console.error("Failed to compact:", err);
        setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
      })
      .finally(() => {
        setIsCompacting(false);
      });
  }, [sessionId, loadMessages]);

  // ─── Effects ─────────────────────────────────────────────────────────────

  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    const init = async () => {
      await loadMessages();
      loadSessionTitle();
      // Always connect — the server decides what to do: prompt an unanswered
      // message, observe a live generation (any process), or report done for
      // an idle chat. The connection stays open to pick up future
      // generations live.
      connect();
    };

    init();

    return () => {
      disconnect();
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

  // Re-sync from the DB when the tab becomes visible again. The SSE keep-alive
  // connection self-heals on its own, but a server restart mid-generation can
  // leave it silently stalled — a visibility refresh snaps the UI back to the
  // true DB state without a full page reload.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void loadMessages();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [loadMessages]);

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
      disconnect();
      abortRef.current?.abort();
    };
  }, [disconnect]);

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
            messages={messages}
            isLoading={isLoading}
            isCompacting={isCompacting}
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
        onCompact={handleCompact}
      />
    </>
  );
}
