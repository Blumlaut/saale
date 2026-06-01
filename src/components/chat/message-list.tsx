"use client";

import { useEffect, useRef, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { Bot, User } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Copy, Check } from "lucide-react";

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

export function MessageList({
  messages,
  streamingToolCalls,
}: {
  messages: Message[];
  streamingToolCalls: ToolCallDisplay[];
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [messages, streamingToolCalls]);

  const handleCopy = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <ScrollArea ref={scrollRef} className="flex-1 px-4 md:px-6">
      <div className="flex flex-col gap-4 py-4">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={cn(
              "flex gap-3 max-w-3xl",
              msg.role === "user" ? "ml-auto flex-row-reverse" : "mr-auto",
            )}
          >
            {/* Avatar */}
            <div
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                msg.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted",
              )}
            >
              {msg.role === "user" ? (
                <User className="h-4 w-4" />
              ) : (
                <Bot className="h-4 w-4" />
              )}
            </div>

            {/* Content */}
            <div
              className={cn(
                "flex flex-col gap-2 rounded-2xl px-4 py-3",
                msg.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : "glass-panel-subtle",
              )}
            >
              {msg.role === "assistant" ? (
                <div className="prose prose-sm dark:prose-invert max-w-none">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {msg.content}
                  </ReactMarkdown>
                </div>
              ) : (
                <p className="whitespace-pre-wrap text-sm">{msg.content}</p>
              )}

              {/* Tool calls */}
              {msg.toolCalls && msg.toolCalls.length > 0 && (
                <div className="mt-2 flex flex-col gap-1">
                  {msg.toolCalls.map((tc) => (
                    <div
                      key={tc.id}
                      className="rounded-lg bg-muted/50 px-3 py-2 text-xs"
                    >
                      <div className="font-medium">{tc.name}</div>
                      {tc.error && (
                        <div className="text-destructive mt-1">{tc.error}</div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Copy button for assistant messages */}
              {msg.role === "assistant" && msg.content && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 self-end opacity-50 hover:opacity-100"
                  onClick={() => handleCopy(msg.content, msg.id)}
                >
                  {copiedId === msg.id ? (
                    <Check className="h-3 w-3" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                </Button>
              )}
            </div>
          </div>
        ))}

        {/* Streaming tool calls */}
        {streamingToolCalls.map((tc) => (
          <div
            key={tc.toolCallId}
            className="flex gap-3 max-w-3xl mr-auto"
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
              <Bot className="h-4 w-4" />
            </div>
            <div className="glass-panel-subtle rounded-2xl px-4 py-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium">{tc.toolName}</span>
                {tc.status === "running" && (
                  <span className="text-muted-foreground animate-pulse">
                    running...
                  </span>
                )}
                {tc.status === "done" && (
                  <span className="text-green-600 dark:text-green-400">
                    completed
                  </span>
                )}
                {tc.status === "error" && (
                  <span className="text-destructive">error</span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}
