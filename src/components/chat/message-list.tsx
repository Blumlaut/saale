"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { MarkdownRenderer } from "./markdown-renderer";
import {
  Loader2,
  Bot,
  User,
  Wrench,
  CheckCircle,
  AlertCircle,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  status?: "running" | "completed" | "error";
}

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  toolCalls?: ToolCall[];
  createdAt: string;
}

interface MessageListProps {
  messages: Message[];
  isLoading?: boolean;
}

export function MessageList({ messages, isLoading }: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <Bot className="mx-auto h-12 w-12 text-muted-foreground/50" />
          <h3 className="mt-4 text-lg font-medium">Start a conversation</h3>
          <p className="text-muted-foreground mt-1 text-sm">
            Ask anything — I can search emails, manage files, and run jobs
          </p>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
        {messages.map((message) => (
          <MessageItem key={message.id} message={message} />
        ))}

        {isLoading && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">Thinking...</span>
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function MessageItem({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const [expandedToolCalls, setExpandedToolCalls] = useState<Set<string>>(new Set());

  const toggleToolCall = (id: string) => {
    setExpandedToolCalls((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div
      className={cn(
        "flex gap-3",
        isUser ? "flex-row-reverse" : "flex-row",
      )}
    >
      {/* Avatar */}
      <div
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
          isUser ? "bg-primary/10" : "bg-muted",
        )}
      >
        {isUser ? (
          <User className="h-4 w-4 text-primary" />
        ) : (
          <Bot className="h-4 w-4 text-muted-foreground" />
        )}
      </div>

      {/* Content */}
      <div className={cn("min-w-0 max-w-[85%] space-y-2")}>
        {/* Message bubble */}
        <div
          className={cn(
            "rounded-2xl px-4 py-3",
            isUser
              ? "bg-primary text-primary-foreground"
              : "bg-white/30 dark:bg-white/5",
          )}
        >
          {isUser ? (
            <div className="whitespace-pre-wrap text-sm">{message.content}</div>
          ) : (
            <MarkdownRenderer content={message.content} />
          )}
        </div>

        {/* Tool calls */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="space-y-1">
            {message.toolCalls.map((toolCall) => (
              <div
                key={toolCall.id}
                className="rounded-xl border bg-white/20 dark:bg-white/5"
              >
                <button
                  className="flex w-full items-center gap-2 px-3 py-2 text-left"
                  onClick={() => toggleToolCall(toolCall.id)}
                >
                  {expandedToolCalls.has(toolCall.id) ? (
                    <ChevronDown className="h-3 w-3 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  )}
                  <Wrench className="h-3 w-3 text-muted-foreground" />
                  <span className="text-xs font-medium">{toolCall.name}</span>
                  <Badge
                    variant="secondary"
                    className={cn(
                      "ml-auto rounded-full px-1.5 py-0 text-[10px]",
                      toolCall.status === "running" && "bg-yellow-500/10 text-yellow-600",
                      toolCall.status === "completed" && "bg-green-500/10 text-green-600",
                      toolCall.status === "error" && "bg-red-500/10 text-red-600",
                    )}
                  >
                    {toolCall.status === "running" && (
                      <Loader2 className="mr-1 h-2.5 w-2.5 animate-spin" />
                    )}
                    {toolCall.status === "completed" && (
                      <CheckCircle className="mr-1 h-2.5 w-2.5" />
                    )}
                    {toolCall.status === "error" && (
                      <AlertCircle className="mr-1 h-2.5 w-2.5" />
                    )}
                    {toolCall.status}
                  </Badge>
                </button>

                {expandedToolCalls.has(toolCall.id) && (
                  <div className="border-t px-3 py-2">
                    <div className="space-y-1">
                      <div className="text-muted-foreground text-xs">
                        <span className="font-medium">Arguments:</span>
                      </div>
                      <pre className="overflow-x-auto rounded-lg bg-muted/50 p-2 text-xs">
                        {JSON.stringify(toolCall.args, null, 2)}
                      </pre>
                      {toolCall.result && (
                        <>
                          <div className="text-muted-foreground text-xs">
                            <span className="font-medium">Result:</span>
                          </div>
                          <pre className="overflow-x-auto rounded-lg bg-muted/50 p-2 text-xs">
                            {toolCall.result.slice(0, 1000)}
                            {toolCall.result.length > 1000 && "..."}
                          </pre>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Timestamp */}
        <div className={cn("text-muted-foreground text-xs", isUser && "text-right")}>
          {new Date(message.createdAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </div>
      </div>
    </div>
  );
}

import { useState } from "react";
