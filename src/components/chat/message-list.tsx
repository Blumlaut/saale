"use client";

import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownRenderer } from "./markdown-renderer";
import { FileCard } from "./file-card";
import { ApprovalMessage } from "./approval-message";
import { CompactionMessage } from "./compaction-message";
import type { ApprovalData, Message } from "./types";
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
  Pencil,
  X,
} from "lucide-react";

interface MessageListProps {
  messages: Message[];
  isLoading?: boolean;
  isCompacting?: boolean;
  onEditMessage?: (messageId: string, newContent: string) => Promise<void>;
  onSendMessage?: (content: string) => void;
  pendingApprovals?: ApprovalData[];
  onApprovalResolved?: (toolCallId: string) => void;
  sessionId?: string;
}

const THRESHOLD = 80; // px from bottom to consider "at bottom"

export function MessageList({
  messages,
  isLoading,
  isCompacting,
  onEditMessage,
  onSendMessage,
  pendingApprovals = [],
  onApprovalResolved,
  sessionId,
}: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [hasJobs, setHasJobs] = useState<boolean | null>(null);

  // Fetch job status to customize empty state suggestions
  useEffect(() => {
    if (messages.length === 0 && hasJobs === null) {
      fetch("/api/jobs")
        .then((res) => res.json())
        .then((data) => setHasJobs(Array.isArray(data.jobs) && data.jobs.length > 0))
        .catch((err) => {
          console.error("Failed to fetch jobs for onboarding:", err);
          setHasJobs(false);
        });
    }
  }, [messages.length, hasJobs]);

  // Track scroll position — unlock auto-scroll when user scrolls up
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setIsAtBottom(distFromBottom <= THRESHOLD);
  }, []);

  // Group consecutive assistant messages that share a parentMessageId
  const groupedMessages = useMemo(() => {
    const groups: Array<
      | { type: "user"; message: Message }
      | { type: "assistant-group"; messages: Message[] }
      | { type: "compaction"; message: Message }
    > = [];
    let i = 0;

    while (i < messages.length) {
      const msg = messages[i]!;
      if (msg.role === "user" || msg.role === "system") {
        groups.push({ type: "user", message: msg });
        i++;
      } else if (msg.role === "compaction") {
        groups.push({ type: "compaction", message: msg });
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

  // Auto-scroll to bottom only while streaming and user is near the bottom (locked-in mode).
  // When streaming, user can scroll up to "unlock" — scrolling back to bottom re-locks.
  // Non-streaming message changes (DB reloads, edits) do NOT auto-scroll.
  useEffect(() => {
    if (isLoading && isAtBottom) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, isLoading, isAtBottom]);

  if (messages.length === 0) {
    const suggestions = [
      ...(hasJobs === false
        ? [
            {
              label: "✨ Create some jobs",
              prompt:
                "Please create some jobs for my account, give them realistic execution times and if a model is required, try being efficient (i.e. prefer cheap/lightweight models for simple tasks, or non-thinking over thinking models)",
            },
          ]
        : []),
      {
        label: "🔍 Search my emails",
        prompt: "Search my emails for recent updates on my projects.",
      },
      {
        label: "📂 List my files",
        prompt: "Show me a list of my recently uploaded files.",
      },
    ];

    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="max-w-md px-4 text-center">
          <Bot className="text-muted-foreground/50 mx-auto h-12 w-12" />
          <h3 className="mt-4 text-lg font-medium">Start a conversation</h3>
          <p className="text-muted-foreground mt-1 mb-6 text-sm">
            {hasJobs === false
              ? "It looks like you don't have any jobs set up. Would you like me to create some for you?"
              : "Ask anything — I can search emails, manage files, and run jobs."}
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {suggestions.map((s) => (
              <Button
                key={s.label}
                variant="outline"
                size="sm"
                className="liquid-glass border-white/10 bg-white/5 hover:bg-white/10"
                onClick={() => onSendMessage?.(s.prompt)}
              >
                {s.label}
              </Button>
            ))}
          </div>
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
    <div ref={containerRef} className="flex-1 overflow-y-auto" onScroll={handleScroll}>
      <div className="space-y-4 px-3 py-4 md:space-y-6 md:px-6 md:py-6">
        {groupedMessages.map((group, groupIndex) =>
          group.type === "compaction" ? (
            <CompactionMessage
              key={group.message.id}
              message={group.message}
              isCompacting={isCompacting ?? false}
            />
          ) : group.type === "user" ? (
            <UserMessageItem
              key={group.message.id}
              message={group.message}
              {...(onEditMessage && { onEdit: onEditMessage })}
            />
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

        {/* Inline tool approval requests */}
        {pendingApprovals.length > 0 && sessionId && (
          <div className="space-y-2">
            {pendingApprovals.map((approval) => (
              <ApprovalMessage
                key={approval.toolCallId}
                sessionId={sessionId}
                approval={approval}
                onResolved={onApprovalResolved ?? (() => {})}
              />
            ))}
          </div>
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

function UserMessageItem({
  message,
  onEdit,
}: {
  message: Message;
  onEdit?: (messageId: string, newContent: string) => Promise<void>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(message.content);
  const [isSaving, setIsSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const startEditing = useCallback(() => {
    setEditDraft(message.content);
    setIsEditing(true);
  }, [message.content]);

  const cancelEditing = useCallback(() => {
    setIsEditing(false);
    setEditDraft(message.content);
  }, [message.content]);

  const saveEditing = useCallback(async () => {
    if (!editDraft.trim() || !onEdit) return;
    setIsSaving(true);
    try {
      await onEdit(message.id, editDraft.trim());
    } finally {
      setIsSaving(false);
      setIsEditing(false);
    }
  }, [message.id, editDraft, onEdit]);

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      saveEditing();
    } else if (e.key === "Escape") {
      cancelEditing();
    }
  };

  const autoResize = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + "px";
    }
  };

  // Focus and resize textarea when entering edit mode
  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
      autoResize();
    }
  }, [isEditing]);

  // Determine image URLs: temp messages use object URLs, real messages use API route
  const imageAttachments = message.attachments?.map((att) => {
    if (att.storageId.startsWith("temp-")) {
      // Temp attachment — we can't reconstruct the object URL, show a placeholder
      return { ...att, url: undefined };
    }
    return { ...att, url: `/api/chat/attachments/${att.storageId}` };
  });

  if (isEditing) {
    return (
      <div className="flex flex-row-reverse gap-3">
        <div className="liquid-glass-pill flex h-8 w-8 shrink-0 items-center justify-center rounded-full">
          <User className="h-4 w-4" />
        </div>
        <div className="max-w-[85%] min-w-0 space-y-2">
          {/* Image attachments (read-only during edit) */}
          {imageAttachments && imageAttachments.length > 0 && (
            <div className="flex flex-row-reverse flex-wrap gap-2">
              {imageAttachments.map((att) =>
                att.url ? (
                  // eslint-disable-next-line @next/next/no-img-element -- dynamic user uploads served via API
                  <img
                    key={att.id}
                    src={att.url}
                    alt={att.fileName}
                    className="ring-border/50 h-24 w-auto max-w-[60%] rounded-xl object-cover ring-1"
                  />
                ) : (
                  <div
                    key={att.id}
                    className="bg-muted/50 text-muted-foreground flex h-24 w-32 items-center justify-center rounded-xl text-xs"
                  >
                    {att.fileName}
                  </div>
                ),
              )}
            </div>
          )}

          {/* Edit textarea */}
          <div className="liquid-glass-inner rounded-2xl px-4 py-3">
            <Textarea
              ref={textareaRef}
              value={editDraft}
              onChange={(e) => {
                setEditDraft(e.target.value);
                autoResize();
              }}
              onKeyDown={handleEditKeyDown}
              className="min-h-[40px] resize-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0"
              rows={1}
              disabled={isSaving}
            />
          </div>

          {/* Edit actions */}
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={cancelEditing}
              disabled={isSaving}
            >
              <X className="mr-1 h-3 w-3" />
              Cancel
            </Button>
            <Button
              size="sm"
              className="liquid-glass-accent h-7 px-2 text-xs"
              onClick={saveEditing}
              disabled={!editDraft.trim() || isSaving}
            >
              {isSaving ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <CheckCircle className="mr-1 h-3 w-3" />
              )}
              Save
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="group/message flex flex-row-reverse gap-3">
      <div className="liquid-glass-pill flex h-8 w-8 shrink-0 items-center justify-center rounded-full">
        <User className="h-4 w-4" />
      </div>
      <div className="max-w-[85%] min-w-0 space-y-2">
        {/* Image attachments */}
        {imageAttachments && imageAttachments.length > 0 && (
          <div className="flex flex-row-reverse flex-wrap gap-2">
            {imageAttachments.map((att) =>
              att.url ? (
                // eslint-disable-next-line @next/next/no-img-element -- dynamic user uploads served via API
                <img
                  key={att.id}
                  src={att.url}
                  alt={att.fileName}
                  className="ring-border/50 h-24 w-auto max-w-[60%] rounded-xl object-cover ring-1"
                />
              ) : (
                <div
                  key={att.id}
                  className="bg-muted/50 text-muted-foreground flex h-24 w-32 items-center justify-center rounded-xl text-xs"
                >
                  {att.fileName}
                </div>
              ),
            )}
          </div>
        )}

        {/* Text content (only when there's text) */}
        {message.content && (
          <div className="liquid-glass-inner rounded-2xl px-4 py-3">
            <div className="text-sm whitespace-pre-wrap">{message.content}</div>
          </div>
        )}
        {/* Timestamp + edit button */}
        <div className="flex items-center justify-end gap-2 text-xs">
          <span className="text-muted-foreground">
            {new Date(message.createdAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
          {onEdit && (
            <button
              onClick={startEditing}
              className="text-muted-foreground hover:text-foreground opacity-0 transition-opacity group-hover/message:opacity-70"
              aria-label="Edit message"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
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
      <div className="liquid-glass-pill flex h-8 w-8 shrink-0 items-center justify-center rounded-full">
        <Bot className="h-4 w-4" />
      </div>

      {/* All turns' content flowing naturally */}
      <div className="max-w-[85%] min-w-0 space-y-2">
        {visibleMessages.map((message) => (
          <div key={message.id}>
            {/* Thinking block */}
            {message.thinking && (
              <div className="liquid-glass-inner rounded-xl">
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
                  <div className="border-border/30 border-t px-3 py-2">
                    <pre className="text-muted-foreground rounded-lg bg-white/10 p-3 text-xs leading-relaxed whitespace-pre-wrap dark:bg-white/5">
                      {message.thinking}
                    </pre>
                  </div>
                )}
              </div>
            )}

            {/* Message bubble (only when there's text) */}
            {message.content && (
              <div className="liquid-glass-inner rounded-2xl px-4 py-3">
                <MarkdownRenderer content={message.content} />
              </div>
            )}

            {/* Streaming indicator for empty current turn */}
            {!message.content &&
              isStreaming &&
              message.id === visibleMessages[visibleMessages.length - 1]?.id && (
                <div className="liquid-glass-inner flex items-center gap-1 rounded-2xl px-4 py-3">
                  <span className="animate-pulse">...</span>
                </div>
              )}

            {/* Tool calls */}
            {message.toolCalls && message.toolCalls.length > 0 && (
              <div className="space-y-1">
                {message.toolCalls.map((toolCall) =>
                  toolCall.name === "show_file" ? (
                    <ShowFileCard key={toolCall.id} toolCall={toolCall} />
                  ) : (
                    <GenericToolCall
                      key={toolCall.id}
                      toolCall={toolCall}
                      expanded={expandedToolCalls.has(toolCall.id)}
                      onToggle={() => toggleToolCall(toolCall.id)}
                    />
                  ),
                )}
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

/**
 * Renders a show_file tool call as a FileCard with preview and download.
 * Extracts file metadata from the tool call args.
 */
function ShowFileCard({ toolCall }: { toolCall: NonNullable<Message["toolCalls"]>[number] }) {
  const filePath = typeof toolCall.args.filePath === "string" ? toolCall.args.filePath : "";
  const fileName = pathBasename(filePath);
  const description =
    typeof toolCall.args.description === "string" ? toolCall.args.description : undefined;

  // Guess MIME from extension (client-side, matches server)
  const ext = filePath.split(".").pop()?.toLowerCase();
  const mimeType = ext ? guessMimeType(ext) : undefined;

  const isError = toolCall.status === "error" || !!toolCall.error;

  return (
    <FileCard
      filePath={filePath}
      fileName={fileName}
      mimeType={mimeType}
      size={undefined}
      description={description}
      isError={isError}
      errorMessage={toolCall.error}
    />
  );
}

/** Simple path.basename polyfill (avoids importing 'path' in client code) */
function pathBasename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

/** Guess MIME type from file extension (client-side, matches server) */
function guessMimeType(ext: string): string {
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    pdf: "application/pdf",
    txt: "text/plain",
    csv: "text/csv",
    json: "application/json",
    xml: "application/xml",
    html: "text/html",
    css: "text/css",
    js: "text/javascript",
    ts: "text/typescript",
    md: "text/markdown",
    yaml: "text/yaml",
    yml: "text/yaml",
    zip: "application/zip",
    gz: "application/gzip",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
  };
  return map[ext] ?? "application/octet-stream";
}

/**
 * Generic tool call accordion for non-show_file tools.
 */
function GenericToolCall({
  toolCall,
  expanded,
  onToggle,
}: {
  toolCall: NonNullable<Message["toolCalls"]>[number];
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
            (toolCall.status === "error" || toolCall.error) && "bg-red-500/10 text-red-600",
          )}
        >
          {toolCall.status === "running" && <Loader2 className="mr-1 h-2.5 w-2.5 animate-spin" />}
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
