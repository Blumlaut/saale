"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { MessageList } from "./message-list";
import { InputBar } from "./input-bar";
import { Loader2, ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    result?: string;
    error?: string;
  }>;
  createdAt: string;
}

interface ToolCallDisplay {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: "running" | "done" | "error";
  result?: string;
  error?: string;
}

export function ChatInterface({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingToolCalls, setStreamingToolCalls] = useState<ToolCallDisplay[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Load messages
  useEffect(() => {
    loadMessages();
  }, [sessionId]);

  const loadMessages = async () => {
    try {
      const res = await fetch(`/api/chat/sessions/${sessionId}/messages`);
      if (res.ok) {
        const data = await res.json();
        setMessages(data.messages);
      }
    } catch {
      // Ignore
    }
  };

  // Send message
  const handleSend = useCallback(
    async (content: string) => {
      // Add user message optimistically
      const userMsg: Message = {
        id: `temp-${Date.now()}`,
        role: "user",
        content,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setIsLoading(true);
      setStreamingText("");
      setStreamingToolCalls([]);

      // Create abort controller
      const abortController = new AbortController();
      abortRef.current = abortController;

      try {
        // Save message to server
        const res = await fetch(
          `/api/chat/sessions/${sessionId}/messages`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content }),
          },
        );

        if (!res.ok) throw new Error("Failed to send message");

        const data = await res.json();

        // Connect to SSE stream
        const eventSource = new EventSource(data.streamUrl);
        eventSourceRef.current = eventSource;

        eventSource.onmessage = (event) => {
          const data = JSON.parse(event.data);

          if (event.type === "token" || event.type === "message") {
            // Handle token events
            if (event.data) {
              const parsed = JSON.parse(event.data);
              if (parsed.text !== undefined) {
                setStreamingText(parsed.text);
              }
            }
          }
        };

        // Custom event handlers
        eventSource.addEventListener("token", (event: MessageEvent) => {
          const parsed = JSON.parse(event.data);
          setStreamingText(parsed.text);
        });

        eventSource.addEventListener("tool_start", (event: MessageEvent) => {
          const parsed = JSON.parse(event.data);
          setStreamingToolCalls((prev) => [
            ...prev,
            {
              toolCallId: parsed.toolCallId,
              toolName: parsed.toolName,
              args: parsed.args,
              status: "running",
            },
          ]);
        });

        eventSource.addEventListener("tool_end", (event: MessageEvent) => {
          const parsed = JSON.parse(event.data);
          setStreamingToolCalls((prev) =>
            prev.map((tc) =>
              tc.toolCallId === parsed.toolCallId
                ? {
                    ...tc,
                    status: parsed.isError ? "error" : "done",
                    result: parsed.result,
                    error: parsed.isError ? parsed.result : undefined,
                  }
                : tc,
            ),
          );
        });

        eventSource.addEventListener("done", (event: MessageEvent) => {
          const parsed = JSON.parse(event.data);
          setStreamingText(parsed.text);
          setIsLoading(false);
          setStreamingToolCalls([]);
          eventSource.close();
          eventSourceRef.current = null;

          // Reload messages to get persisted data
          loadMessages();
        });

        eventSource.onerror = () => {
          eventSource.close();
          eventSourceRef.current = null;
          setIsLoading(false);
          setStreamingToolCalls([]);
          loadMessages();
        };
      } catch (err) {
        setIsLoading(false);
        setStreamingToolCalls([]);
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
    setStreamingToolCalls([]);
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

  // Build display messages (including streaming)
  const displayMessages = [...messages];
  if (isLoading && streamingText) {
    displayMessages.push({
      id: "streaming-assistant",
      role: "assistant",
      content: streamingText,
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
        {isLoading && (
          <Loader2 className="ml-auto h-4 w-4 animate-spin text-muted-foreground" />
        )}
      </div>

      {/* Messages */}
      <MessageList
        messages={displayMessages}
        streamingToolCalls={streamingToolCalls}
      />

      {/* Input */}
      <InputBar
        onSend={handleSend}
        isLoading={isLoading}
        onStop={handleStop}
      />
    </GlassPanel>
  );
}
