"use client";

import { useEffect, useRef, useState, useMemo } from "react";
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
  Lightbulb,
} from "lucide-react";

interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result: string | undefined;
  isError: boolean | undefined;
  status: "running" | "completed" | "error" | undefined;
}

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  thinking: string | undefined;
  toolCalls: ToolCall[] | undefined;
  parentMessageId: string | undefined;
  createdAt: string;
}

interface MessageListProps {
  messages: Message[];
  isLoading?: boolean;
}

export function MessageList({ messages, isLoading }: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Group consecutive assistant messages that share a parentMessageId
  const groupedMessages = useMemo(() => {
    const groups: Array<
      { type: "user"; message: Message } | { type: "assistant-group"; messages: Message[] }
    > = [];
    let i = 0;

    while (i < messages.length) {
      const msg = messages[i]!;
      if (msg.role === "user" || msg.role === "system") {
        groups.push({ type: "user", message: msg });
        i++;
      } else if (msg.role === "assistant") {
        // Collect this message and all consecutive child turns
        const rootId = msg.parentMessageId || msg.id;
        const turnMessages: Message[] = [msg];
        i++;
        while (i < messages.length) {
          const next = messages[i]!;
          if (next.role === "assistant" && next.parentMessageId === rootId) {
            turnMessages.push(next);
            i++;
          } else {
            break;
          }
        }
        groups.push({ type: "assistant-group", messages: turnMessages });
      } else {
        i++;
      }
    }

    return groups;
  }, [messages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <Bot className="text-muted-foreground/50 mx-auto h-12 w-12" />
          <h3 className="mt-4 text-lg font-medium">Start a conversation</h3>
          <p className="text-muted-foreground mt-1 text-sm">
            Ask anything — I can search emails, manage files, and run jobs
          </p>
        </div>
      </div>
    );
  }

  // Check if the last message is streaming
  const lastMsg = messages[messages.length - 1];
  const isStreaming =
    isLoading &&
    lastMsg?.role === "assistant" &&
    (lastMsg.id === "streaming-current" || lastMsg.id.startsWith("streaming-turn-"));

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
        {groupedMessages.map((group, groupIndex) =>
          group.type === "user" ? (
            <UserMessageItem key={group.message.id} message={group.message} />
          ) : (
            <AssistantGroup
              key={groupIndex}
              messages={group.messages}
              isStreaming={
                lastMsg?.id === group.messages[group.messages.length - 1]?.id && !!isStreaming
              }
            />
          ),
        )}
        {isLoading && !isStreaming && (
          <div className="text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">Thinking...</span>
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function UserMessageItem({ message }: { message: Message }) {
  return (
    <div className="flex flex-row-reverse gap-3">
      <div className="bg-primary/10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full">
        <User className="text-primary h-4 w-4" />
      </div>
      <div className="max-w-[85%] min-w-0 space-y-2">
        <div className="bg-primary text-primary-foreground rounded-2xl px-4 py-3">
          <div className="text-sm whitespace-pre-wrap">{message.content}</div>
        </div>
        <div className="text-muted-foreground text-right text-xs">
          {new Date(message.createdAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Renders a group of assistant turns as a single visual unit:
 * one avatar, all turns' content flowing naturally, one timestamp at bottom.
 */
function AssistantGroup({ messages, isStreaming }: { messages: Message[]; isStreaming: boolean }) {
  const [expandedToolCalls, setExpandedToolCalls] = useState<Set<string>>(new Set());
  const [expandedThinking, setExpandedThinking] = useState<Set<string>>(new Set());

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

  const toggleThinking = (messageId: string) => {
    setExpandedThinking((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  };

  // Filter out turns with no content at all
  const visibleMessages = messages.filter(
    (m) => m.content || m.thinking || (m.toolCalls && m.toolCalls.length > 0),
  );

  if (visibleMessages.length === 0) {
    return null;
  }

  // Use the last message's timestamp
  const timestamp = visibleMessages[visibleMessages.length - 1]?.createdAt;

  return (
    <div className="flex gap-3">
      {/* Single avatar for the entire group */}
      <div className="bg-muted flex h-8 w-8 shrink-0 items-center justify-center rounded-full">
        <Bot className="text-muted-foreground h-4 w-4" />
      </div>

      {/* All turns' content flowing naturally */}
      <div className="max-w-[85%] min-w-0 space-y-2">
        {visibleMessages.map((message) => (
          <div key={message.id}>
            {/* Thinking block */}
            {message.thinking && (
              <div className="border-border/50 rounded-xl border bg-white/10 dark:bg-white/5">
                <button
                  className="flex w-full items-center gap-2 px-3 py-2 text-left"
                  onClick={() => toggleThinking(message.id)}
                >
                  {expandedThinking.has(message.id) ? (
                    <ChevronDown className="text-muted-foreground h-3 w-3" />
                  ) : (
                    <ChevronRight className="text-muted-foreground h-3 w-3" />
                  )}
                  <Lightbulb className="text-muted-foreground h-3.5 w-3.5" />
                  <span className="text-muted-foreground text-xs font-medium">
                    {isStreaming && message.id === visibleMessages[visibleMessages.length - 1]?.id
                      ? "Thinking..."
                      : "Thought process"}
                  </span>
                  {isStreaming &&
                    message.id === visibleMessages[visibleMessages.length - 1]?.id && (
                      <Loader2 className="text-muted-foreground h-3 w-3 animate-spin" />
                    )}
                  {!expandedThinking.has(message.id) && message.thinking.length > 60 && (
                    <span className="text-muted-foreground/60 text-xs">
                      {message.thinking.slice(0, 60).trim()}...
                    </span>
                  )}
                </button>

                {expandedThinking.has(message.id) && (
                  <div className="border-border/50 border-t px-3 py-2">
                    <pre className="bg-muted/30 text-muted-foreground rounded-lg p-3 text-xs leading-relaxed whitespace-pre-wrap">
                      {message.thinking}
                    </pre>
                  </div>
                )}
              </div>
            )}

            {/* Message bubble (only when there's text) */}
            {message.content && (
              <div className="rounded-2xl bg-white/30 px-4 py-3 dark:bg-white/5">
                <MarkdownRenderer content={message.content} />
              </div>
            )}

            {/* Streaming indicator for empty current turn */}
            {!message.content &&
              isStreaming &&
              message.id === visibleMessages[visibleMessages.length - 1]?.id && (
                <div className="flex items-center gap-1 rounded-2xl bg-white/30 px-4 py-3 dark:bg-white/5">
                  <span className="animate-pulse">...</span>
                </div>
              )}

            {/* Tool calls */}
            {message.toolCalls && message.toolCalls.length > 0 && (
              <div className="space-y-1">
                {message.toolCalls.map((toolCall) => (
                  <div key={toolCall.id} className="rounded-xl border bg-white/20 dark:bg-white/5">
                    <button
                      className="flex w-full items-center gap-2 px-3 py-2 text-left"
                      onClick={() => toggleToolCall(toolCall.id)}
                    >
                      {expandedToolCalls.has(toolCall.id) ? (
                        <ChevronDown className="text-muted-foreground h-3 w-3" />
                      ) : (
                        <ChevronRight className="text-muted-foreground h-3 w-3" />
                      )}
                      <Wrench className="text-muted-foreground h-3 w-3" />
                      <span className="text-xs font-medium">{toolCall.name}</span>
                      <Badge
                        variant="secondary"
                        className={cn(
                          "ml-auto rounded-full px-1.5 py-0 text-[10px]",
                          toolCall.status === "running" && "bg-yellow-500/10 text-yellow-600",
                          toolCall.status === "completed" && "bg-green-500/10 text-green-600",
                          (toolCall.status === "error" || toolCall.isError) &&
                            "bg-red-500/10 text-red-600",
                        )}
                      >
                        {toolCall.status === "running" && (
                          <Loader2 className="mr-1 h-2.5 w-2.5 animate-spin" />
                        )}
                        {toolCall.status === "completed" && (
                          <CheckCircle className="mr-1 h-2.5 w-2.5" />
                        )}
                        {(toolCall.status === "error" || toolCall.isError) && (
                          <AlertCircle className="mr-1 h-2.5 w-2.5" />
                        )}
                        {toolCall.status || (toolCall.isError ? "error" : "done")}
                      </Badge>
                    </button>

                    {expandedToolCalls.has(toolCall.id) && (
                      <div className="border-t px-3 py-2">
                        <div className="space-y-1">
                          <div className="text-muted-foreground text-xs">
                            <span className="font-medium">Arguments:</span>
                          </div>
                          <pre className="bg-muted/50 overflow-x-auto rounded-lg p-2 text-xs">
                            {JSON.stringify(toolCall.args, null, 2)}
                          </pre>
                          {toolCall.result && (
                            <>
                              <div className="text-muted-foreground text-xs">
                                <span className="font-medium">
                                  {toolCall.isError ? "Error:" : "Result:"}
                                </span>
                              </div>
                              <pre
                                className={cn(
                                  "overflow-x-auto rounded-lg p-2 text-xs",
                                  toolCall.isError ? "bg-red-500/10 text-red-600" : "bg-muted/50",
                                )}
                              >
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
          </div>
        ))}

        {/* Single timestamp for the group */}
        {timestamp && (
          <div className="text-muted-foreground text-xs">
            {new Date(timestamp).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </div>
        )}
      </div>
    </div>
  );
}
