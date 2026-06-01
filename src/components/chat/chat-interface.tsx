"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { GlassPanel } from "@/components/ui/glass-panel";
import { MessageList } from "./message-list";
import { InputBar } from "./input-bar";
import { ModelSelector } from "./model-selector";
import { ThinkingSelector } from "./thinking-selector";
import { Loader2, ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";

interface ToolCallData {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  status?: "running" | "completed" | "error";
}

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  thinking?: string;
  toolCalls?: ToolCallData[];
  createdAt: string;
}

interface StreamingState {
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

export function ChatInterface({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [streaming, setStreaming] = useState<StreamingState>({
    text: "",
    thinking: "",
    toolCalls: [],
  });
  const streamingRef = useRef<StreamingState>(streaming);
  const [modelId, setModelId] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("off");
  const abortRef = useRef<AbortController | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const loadMessages = async () => {
    try {
      const res = await fetch(`/api/chat/sessions/${sessionId}/messages`);
      if (res.ok) {
        const data = await res.json();
        setMessages(data.messages);
        if (data.session) {
          const modelStr =
            data.session.modelProvider && data.session.modelName
              ? `${data.session.modelProvider}/${data.session.modelName}`
              : "";
          if (modelStr) setModelId(modelStr);
          if (data.session.thinkingLevel) setThinkingLevel(data.session.thinkingLevel);
        }
      }
    } catch {
      // Ignore
    }
  };

  // Keep streamingRef in sync
  useEffect(() => {
    streamingRef.current = streaming;
  }, [streaming]);

  // Load messages
  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    loadMessages();
  }, [sessionId]);
  /* eslint-enable react-hooks/exhaustive-deps */

  // Send message
  const handleSend = useCallback(
    async (content: string) => {
      const userMsg: Message = {
        id: `temp-${Date.now()}`,
        role: "user",
        content,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setIsLoading(true);
      setStreaming({ text: "", thinking: "", toolCalls: [] });

      const abortController = new AbortController();
      abortRef.current = abortController;

      try {
        const res = await fetch(`/api/chat/sessions/${sessionId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        });

        if (!res.ok) throw new Error("Failed to send message");

        const data = await res.json();

        if (data.message) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id.startsWith("temp-")
                ? { ...m, id: data.message.id, createdAt: data.message.createdAt }
                : m,
            ),
          );
        }

        const eventSource = new EventSource(data.streamUrl);
        eventSourceRef.current = eventSource;

        eventSource.addEventListener("token", (event: MessageEvent) => {
          const parsed = JSON.parse(event.data);
          setStreaming((prev) => ({ ...prev, text: parsed.text }));
        });

        eventSource.addEventListener("thinking", (event: MessageEvent) => {
          const parsed = JSON.parse(event.data);
          setStreaming((prev) => ({ ...prev, thinking: parsed.thinking }));
        });

        eventSource.addEventListener("tool_start", (event: MessageEvent) => {
          const parsed = JSON.parse(event.data);
          setStreaming((prev) => ({
            ...prev,
            toolCalls: [
              ...prev.toolCalls,
              {
                toolCallId: parsed.toolCallId,
                toolName: parsed.toolName,
                args: parsed.args,
                status: "running" as const,
              },
            ],
          }));
        });

        eventSource.addEventListener("tool_end", (event: MessageEvent) => {
          const parsed = JSON.parse(event.data);
          setStreaming((prev) => ({
            ...prev,
            toolCalls: prev.toolCalls.map((tc) =>
              tc.toolCallId === parsed.toolCallId
                ? {
                    ...tc,
                    status: parsed.isError ? ("error" as const) : ("completed" as const),
                    result: parsed.result,
                    error: parsed.isError ? parsed.result : undefined,
                  }
                : tc,
            ),
          }));
        });

        eventSource.addEventListener("done", (event: MessageEvent) => {
          const parsed = JSON.parse(event.data);
          setIsLoading(false);
          eventSource.close();
          eventSourceRef.current = null;

          // Convert streaming tool calls to message format
          const finalToolCalls: ToolCallData[] | undefined =
            parsed.toolCalls?.length > 0
              ? parsed.toolCalls.map((tc: ToolCallData) => ({
                  id: tc.id,
                  name: tc.name,
                  args: tc.args,
                  isError: tc.isError,
                  status: tc.isError ? "error" : "completed",
                  ...(tc.result ? { result: tc.result } : {}),
                }))
              : streamingRef.current.toolCalls.length > 0
                ? streamingRef.current.toolCalls.map((tc) => ({
                    id: tc.toolCallId,
                    name: tc.toolName,
                    args: tc.args,
                    isError: tc.error !== undefined,
                    status: tc.status === "running" ? "completed" : tc.status,
                    ...(tc.result ? { result: tc.result } : {}),
                  }))
                : undefined;

          setMessages((prev) => [
            ...prev,
            {
              id: `assistant-${Date.now()}`,
              role: "assistant" as const,
              content: parsed.text,
              createdAt: new Date().toISOString(),
              ...(parsed.thinking ? { thinking: parsed.thinking } : {}),
              ...(finalToolCalls ? { toolCalls: finalToolCalls } : {}),
            },
          ]);
        });

        eventSource.onerror = () => {
          eventSource.close();
          eventSourceRef.current = null;
          setIsLoading(false);
          const final = streamingRef.current;
          if (final.text || final.thinking || final.toolCalls.length > 0) {
            const errorToolCalls: ToolCallData[] | undefined =
              final.toolCalls.length > 0
                ? final.toolCalls.map((tc) => ({
                    id: tc.toolCallId,
                    name: tc.toolName,
                    args: tc.args,
                    isError: tc.error !== undefined,
                    status: tc.status === "running" ? "completed" : tc.status,
                    ...(tc.result ? { result: tc.result } : {}),
                  }))
                : undefined;
            setMessages((prev) => [
              ...prev,
              {
                id: `assistant-${Date.now()}`,
                role: "assistant" as const,
                content: final.text,
                createdAt: new Date().toISOString(),
                ...(final.thinking ? { thinking: final.thinking } : {}),
                ...(errorToolCalls ? { toolCalls: errorToolCalls } : {}),
              },
            ]);
          }
        };
      } catch (err) {
        setIsLoading(false);
        console.error("Send error:", err);
      }
    },
    [sessionId],
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
    const partial = streamingRef.current;
    if (partial.text || partial.thinking || partial.toolCalls.length > 0) {
      const stopToolCalls: ToolCallData[] | undefined =
        partial.toolCalls.length > 0
          ? partial.toolCalls.map((tc) => ({
              id: tc.toolCallId,
              name: tc.toolName,
              args: tc.args,
              isError: tc.error !== undefined,
              status: tc.status === "running" ? "completed" : tc.status,
              ...(tc.result ? { result: tc.result } : {}),
            }))
          : undefined;
      setMessages((prev) => [
        ...prev,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant" as const,
          content: partial.text,
          createdAt: new Date().toISOString(),
          ...(partial.thinking ? { thinking: partial.thinking } : {}),
          ...(stopToolCalls ? { toolCalls: stopToolCalls } : {}),
        },
      ]);
    }
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
        await fetch(`/api/chat/sessions/${sessionId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            modelProvider: provider || undefined,
            modelName: modelName || undefined,
            thinkingLevel,
          }),
        });
      } catch {
        // Silently fail
      }
    }, 300);
    return () => clearTimeout(saveTimer);
  }, [modelId, thinkingLevel, sessionId]);

  // Build display messages (including streaming)
  const displayMessages = [...messages];
  if (isLoading && (streaming.text || streaming.thinking || streaming.toolCalls.length > 0)) {
    displayMessages.push({
      id: "streaming-assistant",
      role: "assistant",
      content: streaming.text,
      ...(streaming.thinking ? { thinking: streaming.thinking } : {}),
      ...(streaming.toolCalls.length > 0
        ? {
            toolCalls: streaming.toolCalls.map((tc) => ({
              id: tc.toolCallId,
              name: tc.toolName,
              args: tc.args,
              isError: tc.error !== undefined,
              status: tc.status === "running" ? "running" : "completed",
              ...(tc.result ? { result: tc.result } : {}),
            })),
          }
        : {}),
      createdAt: new Date().toISOString(),
    });
  }

  return (
    <GlassPanel className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="border-border/50 flex items-center gap-2 border-b px-4 py-3">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => router.push("/dashboard/chat")}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="text-sm font-medium">Chat</span>
        {isLoading && <Loader2 className="text-muted-foreground ml-auto h-4 w-4 animate-spin" />}

        {/* Model & thinking selectors */}
        <div className="ml-auto flex items-center gap-1">
          <ModelSelector value={modelId} onChange={setModelId} />
          <ThinkingSelector value={thinkingLevel} onChange={setThinkingLevel} />
        </div>
      </div>

      {/* Messages */}
      <MessageList messages={displayMessages} isLoading={isLoading} />

      {/* Input */}
      <InputBar onSend={handleSend} isLoading={isLoading} onStop={handleStop} />
    </GlassPanel>
  );
}
