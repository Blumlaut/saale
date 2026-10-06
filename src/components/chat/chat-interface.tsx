"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { GlassPanel } from "@/components/ui/glass-panel";
import { MessageList } from "./message-list";
import { InputBar, type InputBarHandle } from "./input-bar";
import { FileDropOverlay } from "./file-drop-overlay";
import { QueuedMessages } from "./queued-messages";
import { fetchJson, patchJson, deleteJson, postJson } from "@/lib/http";
import { useChatDraft } from "@/hooks/use-chat-draft";
import { useFileDrop } from "@/hooks/use-file-drop";
import { mergeMessagesWithLive } from "@/lib/chat/merge-live-messages";
import {
  isTempMessage,
  makeCompactionMessage,
  makeTempUserMessage,
} from "@/lib/chat/message-factories";
import {
  dropOptimistic,
  placementForSend,
  settleQueuedMessage,
  settleSentMessage,
} from "@/lib/chat/outbound-message";
import { sendChatMessage } from "@/lib/chat/send-message";
import type { ToolConfig } from "@/lib/pi/tool-config";
import { useChatSessionState } from "./use-chat-session-state";
import { useStreamingSessions } from "@/hooks/use-streaming-sessions";
import type { Message, ApprovalData, TokenUsage } from "./types";
import { ChatHeader } from "./chat-header";
import { useChatStream } from "./use-chat-stream";

export function ChatInterface({
  sessionId,
  temporaryMode,
  onTemporaryChange,
  onNewChat,
}: {
  sessionId: string;
  temporaryMode: boolean;
  onTemporaryChange: (checked: boolean) => void;
  onNewChat: () => void;
}) {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([]);
  // Messages waiting in the send queue (submitted while Pi was working).
  const [queuedMessages, setQueuedMessages] = useState<Message[]>([]);
  // Queued message whose "send now" request is in flight.
  const [sendingQueuedId, setSendingQueuedId] = useState<string | null>(null);
  // The queue is paused: Stop was pressed, so nothing sends until the user
  // sends a new message or pushes a queued one.
  const [queuePaused, setQueuePaused] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Composer draft — persisted per session, so it survives navigation.
  const { draft, setDraft } = useChatDraft(sessionId);
  // Imperative access to the composer (quote insertion targets its caret).
  const inputBarRef = useRef<InputBarHandle>(null);
  // Files dropped on the chat surface wait in the composer's pending strip,
  // exactly like the paperclip and a pasted file.
  const handleDroppedFiles = useCallback((files: File[]) => {
    inputBarRef.current?.addFiles(files);
  }, []);
  const { isDragging, dropZoneProps } = useFileDrop(handleDroppedFiles);

  // Session state
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalData[]>([]);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  // Tool Pi is running right now (from GET /messages — refresh recovery when
  // the SSE buffer replay is unavailable). Cleared when the tool ends.
  const [activeTool, setActiveTool] = useState<{
    name: string | null;
    startedAt?: string | null;
  } | null>(null);
  // Transient provider failure being retried by Pi — shown instead of a
  // motionless "Thinking..." during the backoff.
  const [retryNotice, setRetryNotice] = useState<{
    attempt: number;
    maxAttempts: number;
    errorMessage: string;
  } | null>(null);
  const { markStreaming, markDone } = useStreamingSessions();

  // Session metadata (title, model, thinking, tool config) + persistence.
  const {
    sessionTitle,
    editingTitle,
    titleDraft,
    setTitleDraft,
    setEditingTitle,
    modelId,
    setModelId,
    thinkingLevel,
    setThinkingLevel,
    toolConfig,
    applySession,
    loadSessionTitle,
    saveTitle,
    toggleTool,
  } = useChatSessionState(sessionId);

  // Abort the in-flight send POST when the component unmounts.
  const abortRef = useRef<AbortController | null>(null);

  // Whether the session is busy — a generation running, or a manual
  // compaction holding it — readable from `handleSend` without making it
  // depend on (and re-create on) every state change.
  const busyRef = useRef(isLoading || isCompacting);

  // False once the component unmounts: async continuations (a compaction
  // request resolving after navigation) must not reopen a connection the
  // unmount cleanup already closed.
  const mountedRef = useRef(true);

  // ─── Data loading ────────────────────────────────────────────────────────

  const loadMessages = useCallback(async (): Promise<void> => {
    try {
      const data = await fetchJson<{
        messages: Message[];
        queuedMessages?: Message[];
        session: {
          modelProvider?: string;
          modelName?: string;
          thinkingLevel?: string;
          toolConfig?: ToolConfig;
          isGenerating?: boolean;
          queueHeld?: boolean;
          activeTool?: { name: string | null; startedAt?: string | null } | null;
        };
      }>(`/api/chat/sessions/${sessionId}/messages`);
      // Merge the DB snapshot with client-side-only live messages (in-flight
      // tokens/tools + the optimistic user message whose POST hasn't resolved
      // yet). A stale snapshot fetched before the POST committed must never
      // wipe the just-sent message, or the UI flashes back to the empty state.
      setMessages((prev) => mergeMessagesWithLive(data.messages, prev));
      setQueuedMessages(data.queuedMessages ?? []);
      setQueuePaused(data.session?.queueHeld ?? false);
      setActiveTool(data.session?.activeTool ?? null);
      applySession(data.session);
    } catch (err) {
      if (err instanceof Error && "status" in err && (err as { status?: number }).status === 404) {
        router.push("/dashboard/chat");
      }
    }
  }, [sessionId, router, applySession]);

  // Latest queue for the stream callback below, which is captured once per
  // connection and must not close over stale state.
  const queuedRef = useRef<Message[]>([]);
  useEffect(() => {
    queuedRef.current = queuedMessages;
  }, [queuedMessages]);

  /**
   * Queue snapshot from the server (mutation, or a run starting after a
   * delivery). A message that left the queue has been handed to the agent, so
   * the conversation has to be reloaded to show it as a normal message.
   */
  const handleQueueUpdate = useCallback(
    (next: Message[]) => {
      const previous = queuedRef.current;
      setQueuedMessages(next);
      // Optimistic entries are local-only: their real row is in this snapshot
      // (or in flight), so their absence is not a delivery that needs a reload.
      if (
        previous.some(
          (queued) => !isTempMessage(queued) && !next.some((item) => item.id === queued.id),
        )
      ) {
        void loadMessages();
      }
    },
    [loadMessages],
  );

  // Shared stream orchestration (declared before the message handlers it
  // references; `onGenerationEnd` is only invoked after mount, by which time
  // `handleSend` is initialized).
  const { connect, disconnect } = useChatStream({
    sessionId,
    eventSourceRef,
    setMessages,
    setIsLoading,
    setPendingApprovals,
    markDone,
    onGenerationEnd: () => {
      // The generation ended, so any in-flight retry did too. The send queue
      // is drained server-side — this client only observes the result.
      setRetryNotice(null);
    },
    onQueueUpdate: handleQueueUpdate,
    onTokenUsage: setTokenUsage,
    onCompactionStart: () => setIsCompacting(true),
    onCompactionEnd: (summary?: string, tokensBefore?: number) => {
      setIsCompacting(false);
      if (summary) {
        setMessages((prev) => [...prev, makeCompactionMessage(summary, tokensBefore ?? 0)]);
      }
    },
    onStreamError: (message) => {
      setRetryNotice(null);
      if (message.includes("No AI model configured")) {
        toast.error("No AI model configured", {
          description: "Select a default model in Settings > AI & Models to start chatting.",
          action: {
            label: "Open Settings",
            onClick: () => router.push("/dashboard/settings"),
          },
        });
      } else {
        // The run never started (session creation, session state, provider
        // setup). Pi persists nothing for it, so without this the message
        // would sit there unanswered and unexplained.
        toast.error("Response failed", { description: message });
      }
    },
    onReload: () => void loadMessages(),
    onRetryStart: (retry) => setRetryNotice(retry),
    onRetryEnd: () => setRetryNotice(null),
  });

  // ─── Message handlers ────────────────────────────────────────────────────

  const handleSend = useCallback(
    async (content: string, files?: File[]) => {
      const optimistic = makeTempUserMessage(content, files);
      // While the session is busy — Pi generating, or a compaction holding it —
      // the server queues the message (the composer's Queue button shows this
      // is what the send means), so the optimistic copy goes straight into the
      // queue strip. Showing it in the conversation first would flash it as
      // sent — and, sitting behind the live turn, replace the streaming
      // indicator with a bare "Thinking…" until the POST response moved it.
      const placement = placementForSend(busyRef.current);
      if (placement === "queue") {
        setQueuedMessages((prev) => [...prev, optimistic]);
      } else {
        setMessages((prev) => [...prev, optimistic]);
        setIsLoading(true);
      }

      const abortController = new AbortController();
      abortRef.current = abortController;

      try {
        const result = await sendChatMessage(sessionId, content, files, abortController.signal);

        // Sending anything resumes a stopped queue (the server clears the hold
        // when it accepts the message).
        if (result.kind === "ok") setQueuePaused(false);

        switch (result.kind) {
          case "not-found":
            router.push("/dashboard/chat");
            return;
          case "conflict":
            // Unexpected: the server queues while a generation runs. Nothing
            // was saved, so hand the text back to the composer.
            setMessages((prev) => dropOptimistic(prev, optimistic));
            setQueuedMessages((prev) => dropOptimistic(prev, optimistic));
            setDraft(content);
            toast.error("Could not send message", {
              description: "The message is back in the input box — try again.",
            });
            return;
          case "error":
            throw new Error(result.message);
          case "ok": {
            const saved: Message = {
              ...optimistic,
              id: result.message.id,
              createdAt: result.message.createdAt,
              attachments: result.message.attachments?.length
                ? result.message.attachments
                : undefined,
            };

            if (result.queued) {
              // Pi is still working: the message waits in the send queue and
              // must not be part of the conversation.
              setMessages((prev) => dropOptimistic(prev, optimistic));
              setQueuedMessages((prev) => settleQueuedMessage(prev, optimistic, saved));
              // Top-center: a bottom toast would cover the composer and the
              // queue strip it is talking about.
              toast.info("Queued", {
                description: "Sent as soon as the current response finishes.",
                position: "top-center",
              });
              // No reconnect: the running generation already streams on this
              // connection, and it drains the queue when it settles.
              return;
            }

            // Delivered now. If this client misread the session as busy, the
            // message is in the queue strip and has to move into the
            // conversation.
            setQueuedMessages((prev) => dropOptimistic(prev, optimistic, saved));
            setMessages((prev) => settleSentMessage(prev, optimistic, saved));
            if (placement === "queue") setIsLoading(true);

            // Connect to the SSE stream — the server prompts and streams
            // events. A keep-alive observer connection is already open, but
            // it was decided when the chat was idle, so it never claims the
            // pending prompt. Reconnect to force the server to re-decide
            // (prompt, or observe a run already in flight) and dispatch the
            // message to the LLM immediately.
            disconnect();
            connect();
            return;
          }
        }
      } catch (err) {
        // Only undo the loading state this send raised — when the message was
        // queued, the loading state belongs to the run that made it queue.
        if (placement === "conversation") setIsLoading(false);
        // The message never reached the DB — drop the optimistic copy so a
        // failed send can't linger as a phantom (loadMessages preserves temp
        // user messages while a POST is in flight, so without this cleanup a
        // failure would leave it stuck forever). Skip on abort: that only
        // happens on unmount, where the component is going away anyway.
        if (!(err instanceof Error && err.name === "AbortError")) {
          setMessages((prev) => dropOptimistic(prev, optimistic));
          setQueuedMessages((prev) => dropOptimistic(prev, optimistic));
          // Don't lose what the user typed.
          setDraft(content);
          console.error("Send error:", err);
          toast.error("Failed to send message", {
            description: err instanceof Error ? err.message : "Something went wrong.",
          });
        }
      }
    },
    [sessionId, router, connect, disconnect, setDraft],
  );

  // ─── Send queue actions ──────────────────────────────────────────────────

  const handleEditQueued = useCallback(
    async (messageId: string, content: string) => {
      try {
        const data = await patchJson<{ message: Message }>(
          `/api/chat/sessions/${sessionId}/queue/${messageId}`,
          { content },
        );
        setQueuedMessages((prev) => prev.map((m) => (m.id === messageId ? data.message : m)));
      } catch (err) {
        console.error("Failed to edit queued message:", err);
        toast.error("Failed to update the queued message", {
          description: err instanceof Error ? err.message : "Something went wrong.",
        });
        await loadMessages();
      }
    },
    [sessionId, loadMessages],
  );

  const handleCancelQueued = useCallback(
    async (messageId: string) => {
      try {
        await deleteJson(`/api/chat/sessions/${sessionId}/queue/${messageId}`);
        setQueuedMessages((prev) => prev.filter((m) => m.id !== messageId));
      } catch (err) {
        console.error("Failed to cancel queued message:", err);
        toast.error("Failed to cancel the queued message", {
          description: err instanceof Error ? err.message : "Something went wrong.",
        });
        await loadMessages();
      }
    },
    [sessionId, loadMessages],
  );

  const handleSendQueuedNow = useCallback(
    async (messageId: string) => {
      setSendingQueuedId(messageId);
      try {
        const data = await postJson<{ delivered: boolean; mode?: "steered" | "prompt" }>(
          `/api/chat/sessions/${sessionId}/queue/${messageId}`,
          {},
        );
        setQueuePaused(false);
        if (data.mode === "prompt") {
          // Idle session: the prompt path takes over — reconnect so the server
          // claims it and prompts immediately.
          setQueuedMessages((prev) => prev.filter((m) => m.id !== messageId));
          setIsLoading(true);
          disconnect();
          connect();
        }
        // Steered into the running turn, or prompted: the message is part of
        // the conversation now.
        await loadMessages();
      } catch (err) {
        if (
          err instanceof Error &&
          "status" in err &&
          (err as { status?: number }).status === 409
        ) {
          toast.info("Still busy", {
            description: "The message stays queued and is sent as soon as the run finishes.",
          });
          await loadMessages();
        } else {
          console.error("Failed to send queued message now:", err);
          toast.error("Failed to send the message now", {
            description: err instanceof Error ? err.message : "Something went wrong.",
          });
        }
      } finally {
        setSendingQueuedId(null);
      }
    },
    [sessionId, connect, disconnect, loadMessages],
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
        // Force a fresh connection (same rationale as handleSend): the open
        // keep-alive observer was decided when idle and would never claim
        // the pending prompt set by the PATCH.
        disconnect();
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
    [sessionId, connect, disconnect, loadMessages],
  );

  // ─── MessageList callbacks ───────────────────────────────────────────────
  // Stable identities: MessageList is memoized, so inline arrows here would
  // defeat the memo and re-render every message on each keystroke.

  const handleApprovalResolved = useCallback((toolCallId: string) => {
    setPendingApprovals((prev) => prev.filter((a) => a.toolCallId !== toolCallId));
  }, []);

  const handleSuggestionSend = useCallback(
    (content: string) => {
      void handleSend(content);
    },
    [handleSend],
  );

  const handleQuoteSelection = useCallback((text: string) => {
    inputBarRef.current?.insertQuote(text);
    // Drop the highlight so the floating Quote button doesn't reappear.
    window.getSelection()?.removeAllRanges();
  }, []);

  const handleStop = useCallback(() => {
    // Stop means "nothing more until I say so": the server pauses the send
    // queue, so queued messages wait for an explicit send/push.
    setQueuePaused(true);
    // Settle through the server's own decision rather than waiting for an
    // abort this process may not own: when the run is already dead (Saale
    // restarted mid-generation) or owned by another process, nothing will
    // ever publish the `done` this client is waiting for. Reconnecting makes
    // the server re-decide with the flags cleared — a stopped session is told
    // `done`, and one whose run is still aborting delivers the tracker's own
    // `done` on the new connection.
    void fetch(`/api/chat/sessions/${sessionId}/stop`, { method: "POST" })
      .catch((err) => {
        console.error("Failed to call stop endpoint:", err);
      })
      .finally(() => {
        if (!mountedRef.current) return;
        disconnect();
        connect();
      });
  }, [sessionId, connect, disconnect]);

  const handleCompact = useCallback(() => {
    setIsCompacting(true);
    setTokenUsage(null);

    // Add optimistic compaction message so the user sees feedback immediately
    const optimisticId = `temp-compaction-${Date.now()}`;
    setMessages((prev) => [...prev, makeCompactionMessage("", 0, optimisticId)]);

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
        // The compaction held the session, so anything sent during it is
        // queued: reconnect so the server re-decides — its idle path drains
        // the send queue — instead of leaving the messages in the strip.
        if (mountedRef.current) {
          disconnect();
          connect();
        }
      });
  }, [sessionId, connect, disconnect, loadMessages]);

  // ─── Effects ─────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      await loadMessages();
      await loadSessionTitle();
      // Unmounted mid-load (navigated away): connecting here would open a
      // stream no cleanup would ever close.
      if (cancelled) return;
      // Always connect — the server decides what to do: prompt an unanswered
      // message, observe a live generation (any process), or report done for
      // an idle chat. The connection stays open to pick up future
      // generations live.
      connect();
    };

    void init();

    return () => {
      cancelled = true;
      disconnect();
    };
  }, [sessionId, connect, disconnect, loadMessages, loadSessionTitle]);

  // Temporary session auto-delete on unmount (only after the tab has been
  // open long enough to be a real visit, never while a generation runs, and
  // never while the send queue still holds messages for it).
  const temporaryRef = useRef(temporaryMode);
  const queuedCountRef = useRef(queuedMessages.length);
  const mountTimeRef = useRef(0);

  useEffect(() => {
    mountTimeRef.current = Date.now();
  }, []);

  useEffect(() => {
    temporaryRef.current = temporaryMode;
  }, [temporaryMode]);

  useEffect(() => {
    busyRef.current = isLoading || isCompacting;
  }, [isLoading, isCompacting]);

  useEffect(() => {
    queuedCountRef.current = queuedMessages.length;
  }, [queuedMessages]);

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
      if (!temporaryRef.current || busyRef.current) return;
      if (queuedCountRef.current > 0) return;

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
      mountedRef.current = false;
      disconnect();
      abortRef.current?.abort();
    };
  }, [disconnect]);

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div
      data-slot="chat-drop-zone"
      className="relative flex min-h-0 flex-1 flex-col"
      {...dropZoneProps}
    >
      <GlassPanel className="flex flex-1 flex-col overflow-hidden rounded-none border-0 md:rounded-2xl">
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
          onSaveTitle={saveTitle}
          onModelChange={setModelId}
          onThinkingChange={setThinkingLevel}
          onTemporaryChange={onTemporaryChange}
          onNewChat={onNewChat}
        />

        <div className="flex min-h-0 flex-1 flex-col">
          <MessageList
            messages={messages}
            isLoading={isLoading}
            isCompacting={isCompacting}
            onEditMessage={handleEditMessage}
            onSendMessage={handleSuggestionSend}
            onQuoteSelection={handleQuoteSelection}
            pendingApprovals={pendingApprovals}
            onApprovalResolved={handleApprovalResolved}
            sessionId={sessionId}
            activeTool={activeTool}
            retry={retryNotice}
          />
        </div>
      </GlassPanel>

      <QueuedMessages
        messages={queuedMessages}
        sendingId={sendingQueuedId}
        paused={queuePaused}
        onEdit={handleEditQueued}
        onSendNow={handleSendQueuedNow}
        onCancel={handleCancelQueued}
      />

      <InputBar
        ref={inputBarRef}
        onSend={handleSend}
        value={draft}
        onValueChange={setDraft}
        isLoading={isLoading}
        onStop={handleStop}
        toolConfig={toolConfig}
        onToggleTool={toggleTool}
        tokenUsage={tokenUsage}
        isCompacting={isCompacting}
        onCompact={handleCompact}
      />

      {isDragging && <FileDropOverlay />}
    </div>
  );
}
