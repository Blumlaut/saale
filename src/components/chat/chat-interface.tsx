"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { GlassPanel } from "@/components/ui/glass-panel";
import { MessageList } from "./message-list";
import { InputBar, type ToolConfig } from "./input-bar";
import { ModelPicker } from "@/components/shared/model-picker";
import { ThinkingSelector } from "./thinking-selector";
import { Loader2, ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";

interface ToolCallData {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result: string | undefined;
  isError: boolean | undefined;
  status: "running" | "completed" | "error" | undefined;
}

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

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  thinking: string | undefined;
  toolCalls: ToolCallData[] | undefined;
  parentMessageId: string | undefined;
  createdAt: string;
}

interface StreamingState {
  /** Completed turns (finalized from turn_end events) */
  turns: TurnData[];
  /** Current in-progress turn data */
  current: TurnData;
}

const DEFAULT_TOOL_CONFIG: ToolConfig = {
  bash: true,
  files: true,
  email: true,
  jobs: true,
  chatSearch: true,
};

const emptyTurn = (): TurnData => ({
  text: "",
  thinking: "",
  toolCalls: [],
});

export function ChatInterface({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [streaming, setStreaming] = useState<StreamingState>({
    turns: [],
    current: emptyTurn(),
  });
  const streamingRef = useRef<StreamingState>(streaming);
  const [modelId, setModelId] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("off");
  const [toolConfig, setToolConfig] = useState<ToolConfig>(DEFAULT_TOOL_CONFIG);
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
          if (data.session.toolConfig) {
            setToolConfig({ ...DEFAULT_TOOL_CONFIG, ...data.session.toolConfig });
          }
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

  // Toggle a tool category and persist
  const handleToggleTool = useCallback(
    async (category: keyof ToolConfig) => {
      const updated = { ...toolConfig, [category]: !toolConfig[category] };
      setToolConfig(updated);

      try {
        await fetch(`/api/chat/sessions/${sessionId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ toolConfig: updated }),
        });
      } catch {
        // Silently fail — local state is already updated
      }
    },
    [toolConfig, sessionId],
  );

  /** Convert streaming tool calls to message format */
  const convertToolCalls = (
    toolCalls: Array<{
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      status: "running" | "completed" | "error";
      result?: string;
      error?: string;
    }>,
  ): ToolCallData[] => {
    if (toolCalls.length === 0) return [];
    return toolCalls.map((tc) => ({
      id: tc.toolCallId,
      name: tc.toolName,
      args: tc.args,
      isError: tc.error !== undefined,
      status: tc.status === "running" ? "completed" : tc.status,
      result: tc.result ?? undefined,
    }));
  };

  // Send message
  const handleSend = useCallback(
    async (content: string) => {
      const userMsg: Message = {
        id: `temp-${Date.now()}`,
        role: "user",
        content,
        thinking: undefined,
        toolCalls: undefined,
        parentMessageId: undefined,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setIsLoading(true);
      setStreaming({ turns: [], current: emptyTurn() });

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
                        status: tc.isError ? "error" : "completed",
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
          const finalState = streamingRef.current;
          const allTurns = [
            ...finalState.turns,
            // Include the current turn if it has any content and wasn't already finalized
            ...(finalState.current.text ||
            finalState.current.thinking ||
            finalState.current.toolCalls.length > 0
              ? [{ ...finalState.current }]
              : []),
          ];

          // If we got turn_end events, use those. Otherwise create a single message from streaming state.
          const parsed = JSON.parse(event.data);

          if (allTurns.length > 0) {
            // Multi-turn response: add each turn as a separate message
            const baseId = `assistant-turn-${Date.now()}`;
            const turnMessages: Message[] = allTurns.map((turn, index) => ({
              id: `${baseId}-${index}`,
              role: "assistant" as const,
              content: turn.text,
              thinking: turn.thinking || undefined,
              toolCalls: turn.toolCalls.length > 0 ? convertToolCalls(turn.toolCalls) : undefined,
              parentMessageId: index > 0 ? `${baseId}-0` : undefined,
              createdAt: new Date().toISOString(),
            }));
            setMessages((prev) => [...prev, ...turnMessages]);
          } else if (parsed.text || parsed.thinking || parsed.toolCalls?.length > 0) {
            // Legacy single-turn fallback (from done event data)
            const finalToolCalls: ToolCallData[] | undefined =
              parsed.toolCalls?.length > 0
                ? parsed.toolCalls.map((tc: ToolCallData) => ({
                    id: tc.id,
                    name: tc.name,
                    args: tc.args,
                    isError: tc.isError,
                    status: tc.isError ? "error" : "completed",
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
              },
            ]);
          }
        });

        eventSource.onerror = () => {
          eventSource.close();
          eventSourceRef.current = null;
          setIsLoading(false);
          const final = streamingRef.current;

          // Collect all turns including current
          const allTurns = [
            ...final.turns,
            ...(final.current.text || final.current.thinking || final.current.toolCalls.length > 0
              ? [{ ...final.current }]
              : []),
          ];

          if (allTurns.length > 0) {
            const baseId = `assistant-turn-${Date.now()}`;
            const turnMessages: Message[] = allTurns.map((turn, index) => ({
              id: `${baseId}-${index}`,
              role: "assistant" as const,
              content: turn.text,
              thinking: turn.thinking || undefined,
              toolCalls: turn.toolCalls.length > 0 ? convertToolCalls(turn.toolCalls) : undefined,
              parentMessageId: index > 0 ? `${baseId}-0` : undefined,
              createdAt: new Date().toISOString(),
            }));
            setMessages((prev) => [...prev, ...turnMessages]);
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

    // Collect all turns including current
    const allTurns = [
      ...partial.turns,
      ...(partial.current.text || partial.current.thinking || partial.current.toolCalls.length > 0
        ? [{ ...partial.current }]
        : []),
    ];

    if (allTurns.length > 0) {
      const baseId = `assistant-turn-${Date.now()}`;
      const turnMessages: Message[] = allTurns.map((turn, index) => ({
        id: `${baseId}-${index}`,
        role: "assistant" as const,
        content: turn.text,
        thinking: turn.thinking || undefined,
        toolCalls: turn.toolCalls.length > 0 ? convertToolCalls(turn.toolCalls) : undefined,
        parentMessageId: index > 0 ? `${baseId}-0` : undefined,
        createdAt: new Date().toISOString(),
      }));
      setMessages((prev) => [...prev, ...turnMessages]);
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
        displayMessages.push({
          id: `streaming-turn-${i}`,
          role: "assistant",
          content: turn.text,
          thinking: turn.thinking || undefined,
          toolCalls:
            turn.toolCalls.length > 0
              ? turn.toolCalls.map((tc) => ({
                  id: tc.toolCallId,
                  name: tc.toolName,
                  args: tc.args,
                  isError: tc.error !== undefined,
                  status: tc.status,
                  result: tc.result || undefined,
                }))
              : undefined,
          createdAt: new Date().toISOString(),
          parentMessageId: i > 0 ? `streaming-turn-0` : undefined,
        });
      }

      // Add current in-progress turn
      if (
        streaming.current.text ||
        streaming.current.thinking ||
        streaming.current.toolCalls.length > 0
      ) {
        displayMessages.push({
          id: "streaming-current",
          role: "assistant",
          content: streaming.current.text,
          thinking: streaming.current.thinking || undefined,
          toolCalls:
            streaming.current.toolCalls.length > 0
              ? streaming.current.toolCalls.map((tc) => ({
                  id: tc.toolCallId,
                  name: tc.toolName,
                  args: tc.args,
                  isError: tc.error !== undefined,
                  status: tc.status,
                  result: tc.result || undefined,
                }))
              : undefined,
          createdAt: new Date().toISOString(),
          parentMessageId: streaming.turns.length > 0 ? `streaming-turn-0` : undefined,
        });
      }
    }
  }

  return (
    <GlassPanel className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="border-border/50 flex items-center gap-2 border-b px-3 py-2.5 md:px-4 md:py-3">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 md:h-8 md:w-8"
          onClick={() => router.push("/dashboard/chat")}
        >
          <ChevronLeft className="h-3.5 w-3.5 md:h-4 md:w-4" />
        </Button>
        <span className="text-xs font-medium md:text-sm">Chat</span>
        {isLoading && (
          <Loader2 className="text-muted-foreground ml-auto h-3.5 w-3.5 animate-spin md:h-4 md:w-4" />
        )}

        {/* Model & thinking selectors — hidden on small mobile */}
        <div className="ml-auto flex items-center gap-1">
          <ModelPicker value={modelId} onChange={setModelId} />
          <ThinkingSelector value={thinkingLevel} onChange={setThinkingLevel} />
        </div>
      </div>

      {/* Messages */}
      <MessageList messages={displayMessages} isLoading={isLoading} />

      {/* Input */}
      <InputBar
        onSend={handleSend}
        isLoading={isLoading}
        onStop={handleStop}
        toolConfig={toolConfig}
        onToggleTool={handleToggleTool}
      />
    </GlassPanel>
  );
}
