"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Bot, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarkdownRenderer } from "./markdown-renderer";
import { CompactionMessage } from "./compaction-message";
import { CopyButton } from "./copy-button";
import { CollapsedToolCalls } from "./collapsed-tool-calls";
import { RedactedToolCall } from "./redacted-tool-call";
import { ProviderErrorNotice } from "./provider-error-notice";
import { groupMessages } from "@/lib/chat/group-messages";
import { getAssistantCopyText } from "@/lib/chat/copy-response";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import type { Message } from "./types";

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
          <p className="text-muted-foreground mt-0.5 text-xs">
            Tool details are hidden in shared chats
          </p>
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
  const groupedMessages = useMemo(() => groupMessages(messages), [messages]);

  // Auto-scroll to bottom on mount
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView();
  }, []);

  return (
    <div ref={containerRef}>
      {groupedMessages.map((group, groupIndex) =>
        group.type === "compaction" ? (
          <CompactionMessage key={group.message.id} message={group.message} />
        ) : group.type === "user" ? (
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
  // An errored turn is kept even when empty — the error notice is all there is.
  const visibleMessages = messages.filter(
    (m) => m.content || m.thinking || m.errorMessage || (m.toolCalls && m.toolCalls.length > 0),
  );

  if (visibleMessages.length === 0) {
    return null;
  }

  const timestamp = visibleMessages[visibleMessages.length - 1]?.createdAt;

  // Combined response text for the copy button (empty when no turn has text)
  const copyText = getAssistantCopyText(visibleMessages);

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
            {message.errorMessage && <ProviderErrorNotice error={message.errorMessage} />}
            {message.toolCalls && message.toolCalls.length > 0 && (
              <div className="space-y-1">
                <CollapsedToolCalls toolCalls={message.toolCalls} renderCall={RedactedToolCall} />
              </div>
            )}
          </div>
        ))}
        {timestamp && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">{formatTime(timestamp)}</span>
            {copyText && (
              <CopyButton
                text={copyText}
                label="Copy response"
                className="text-muted-foreground hover:text-foreground transition-colors"
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function formatTime(isoString: string): string {
  return new Date(isoString).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}
