"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  Bot,
  User,
  Wrench,
  CheckCircle,
  AlertCircle,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MarkdownRenderer } from "./markdown-renderer";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import type { Message, ToolCallData } from "./types";

interface ShareViewerProps {
  token: string;
  sessionTitle: string;
  messages: Message[];
  isAuthenticated: boolean;
}

export function ShareViewer({ token, sessionTitle, messages, isAuthenticated }: ShareViewerProps) {
  const router = useRouter();
  const [isCopied, setIsCopied] = useState(false);
  const [isCopying, setIsCopying] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  const handleCopy = async () => {
    setIsCopying(true);
    setCopyError(null);
    try {
      const res = await fetch(`/api/chat/sessions/share/${token}/copy`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        setCopyError(data.error || "Failed to copy chat");
        return;
      }
      setIsCopied(true);
      router.push(`/dashboard/chat/${data.sessionId}`);
    } catch (err) {
      console.error("Failed to copy chat:", err);
      setCopyError("Failed to copy chat");
    } finally {
      setIsCopying(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col">
      {/* Header */}
      <div className="border-border/30 flex shrink-0 items-center justify-between border-b px-4 py-3 md:px-6 md:py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
              Shared Chat
            </span>
          </div>
          <h1 className="mt-0.5 truncate text-base font-semibold md:text-lg">{sessionTitle}</h1>
        </div>
        {isAuthenticated ? (
          <Button
            className="liquid-glass-accent ml-4 shrink-0"
            size="sm"
            onClick={handleCopy}
            disabled={isCopying || isCopied}
          >
            {isCopying ? "Copying..." : isCopied ? "Copied!" : "Copy to my account"}
          </Button>
        ) : (
          <Button
            className="liquid-glass-accent ml-4 shrink-0"
            size="sm"
            onClick={() => router.push(`/auth/login?redirect=/share/${token}`)}
          >
            Sign in to copy
          </Button>
        )}
      </div>

      {copyError && (
        <div className="bg-destructive/10 text-destructive border-border/30 border-b px-4 py-2 text-sm">
          {copyError}
        </div>
      )}

      {/* Messages */}
      <GlassPanel className="flex flex-1 flex-col overflow-hidden border-0">
        <GlassPanelContent className="flex flex-1 flex-col overflow-hidden p-0">
          <div className="flex-1 overflow-y-auto">
            <div className="space-y-4 px-3 py-4 md:space-y-6 md:px-6 md:py-6">
              {messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <Bot className="text-muted-foreground/50 h-12 w-12" />
                  <h3 className="mt-4 text-lg font-medium">Empty conversation</h3>
                  <p className="text-muted-foreground mt-1 text-sm">
                    This shared chat has no messages
                  </p>
                </div>
              ) : (
                <ShareMessageList messages={messages} />
              )}
            </div>
          </div>
        </GlassPanelContent>
      </GlassPanel>

      {/* Footer */}
      <div className="border-border/30 flex shrink-0 items-center justify-between border-t px-4 py-3 md:px-6">
        <span className="text-muted-foreground text-xs">
          Powered by{" "}
          <span className="font-medium">
            Sa<span className="text-primary">ale</span>
          </span>
        </span>
        {!isAuthenticated && (
          <button
            onClick={() => router.push(`/auth/login?redirect=/share/${token}`)}
            className="text-muted-foreground hover:text-foreground text-xs transition-colors"
          >
            Sign in to continue this conversation
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Read-only message list (no editing, no streaming)                 */
/* ------------------------------------------------------------------ */

function ShareMessageList({ messages }: { messages: Message[] }) {
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

  // Auto-scroll to bottom on mount
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView();
  }, []);

  return (
    <div ref={containerRef}>
      {groupedMessages.map((group, groupIndex) =>
        group.type === "user" ? (
          <ShareUserMessage key={group.message.id} message={group.message} />
        ) : (
          <ShareAssistantGroup key={groupIndex} messages={group.messages} />
        ),
      )}
      <div ref={bottomRef} />
    </div>
  );
}

function ShareUserMessage({ message }: { message: Message }) {
  return (
    <div className="flex flex-row-reverse gap-3">
      <div className="liquid-glass-pill flex h-8 w-8 shrink-0 items-center justify-center rounded-full">
        <User className="h-4 w-4" />
      </div>
      <div className="max-w-[85%] min-w-0">
        {message.content && (
          <div className="liquid-glass-inner rounded-2xl px-4 py-3">
            <div className="text-sm whitespace-pre-wrap">{message.content}</div>
          </div>
        )}
        <div className="mt-1 text-right text-xs">
          <span className="text-muted-foreground">{formatTime(message.createdAt)}</span>
        </div>
      </div>
    </div>
  );
}

function ShareAssistantGroup({ messages }: { messages: Message[] }) {
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

  // Filter out turns with no content at all
  const visibleMessages = messages.filter(
    (m) => m.content || (m.toolCalls && m.toolCalls.length > 0),
  );

  if (visibleMessages.length === 0) {
    return null;
  }

  const timestamp = visibleMessages[visibleMessages.length - 1]?.createdAt;

  return (
    <div className="flex gap-3">
      <div className="liquid-glass-pill flex h-8 w-8 shrink-0 items-center justify-center rounded-full">
        <Bot className="h-4 w-4" />
      </div>
      <div className="max-w-[85%] min-w-0 space-y-2">
        {visibleMessages.map((message) => (
          <div key={message.id}>
            {message.content && (
              <div className="liquid-glass-inner rounded-2xl px-4 py-3">
                <MarkdownRenderer content={message.content} />
              </div>
            )}
            {message.toolCalls && message.toolCalls.length > 0 && (
              <div className="space-y-1">
                {message.toolCalls.map((toolCall) => (
                  <ShareGenericToolCall
                    key={toolCall.id}
                    toolCall={toolCall}
                    expanded={expandedToolCalls.has(toolCall.id)}
                    onToggle={() => toggleToolCall(toolCall.id)}
                  />
                ))}
              </div>
            )}
          </div>
        ))}
        {timestamp && <div className="text-muted-foreground text-xs">{formatTime(timestamp)}</div>}
      </div>
    </div>
  );
}

function ShareGenericToolCall({
  toolCall,
  expanded,
  onToggle,
}: {
  toolCall: ToolCallData;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="liquid-glass-inner rounded-xl">
      <button className="flex w-full items-center gap-2 px-3 py-2 text-left" onClick={onToggle}>
        {expanded ? (
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
            (toolCall.status === "error" || !!toolCall.error) && "bg-red-500/10 text-red-600",
          )}
        >
          {toolCall.status === "running" && <Wrench className="mr-1 h-2.5 w-2.5" />}
          {toolCall.status === "completed" && <CheckCircle className="mr-1 h-2.5 w-2.5" />}
          {(toolCall.status === "error" || toolCall.error) && (
            <AlertCircle className="mr-1 h-2.5 w-2.5" />
          )}
          {toolCall.status || (toolCall.error ? "error" : "done")}
        </Badge>
      </button>
      {expanded && (
        <div className="border-border/30 border-t px-3 py-2">
          <div className="space-y-1">
            <div className="text-muted-foreground text-xs">
              <span className="font-medium">Arguments:</span>
            </div>
            <pre className="overflow-x-auto rounded-lg bg-white/10 p-2 text-xs dark:bg-white/5">
              {JSON.stringify(toolCall.args, null, 2)}
            </pre>
            {toolCall.result && (
              <>
                <div className="text-muted-foreground text-xs">
                  <span className="font-medium">{toolCall.error ? "Error:" : "Result:"}</span>
                </div>
                <pre
                  className={cn(
                    "overflow-x-auto rounded-lg p-2 text-xs",
                    toolCall.error ? "bg-red-500/10 text-red-600" : "bg-white/10 dark:bg-white/5",
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
  );
}

function formatTime(isoString: string): string {
  return new Date(isoString).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}
