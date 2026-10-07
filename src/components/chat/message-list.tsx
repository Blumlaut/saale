"use client";

import { memo, useEffect, useRef, useState, useMemo, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownRenderer } from "./markdown-renderer";
import { LightboxImage } from "./image-lightbox";
import { ApprovalMessage } from "./approval-message";
import { CompactionMessage } from "./compaction-message";
import { CopyButton } from "./copy-button";
import { SelectionQuoteButton } from "./selection-quote-button";
import { ToolCallView } from "./tool-call-view";
import { ToolCallRun } from "./tool-call-run";
import { ProviderErrorNotice } from "./provider-error-notice";
import { formatProviderError } from "@/lib/pi/provider-error";
import { groupMessages } from "@/lib/chat/group-messages";
import { getAssistantCopyText } from "@/lib/chat/copy-response";
import { isStreamingMessage } from "@/lib/chat/message-factories";
import { formatFileSize } from "@/lib/utils";
import type { ApprovalData, Message, AttachmentData } from "./types";
import {
  Loader2,
  Bot,
  User,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  History,
  Lightbulb,
  Pencil,
  X,
  FileText,
  File as FileIcon,
  AlertTriangle,
} from "lucide-react";

interface MessageListProps {
  messages: Message[];
  isLoading?: boolean;
  isCompacting?: boolean;
  onEditMessage?: (messageId: string, newContent: string) => Promise<void>;
  onSendMessage?: (content: string) => void;
  /** Inserts a quoted selection into the composer. */
  onQuoteSelection?: (text: string) => void;
  pendingApprovals?: ApprovalData[];
  onApprovalResolved?: (toolCallId: string) => void;
  sessionId?: string;
  /** The tool Pi is currently running (from the session, for refresh recovery). */
  activeTool?: { name: string | null; startedAt?: string | null } | null;
  /** Set while a failed provider call is being retried. */
  retry?: { attempt: number; maxAttempts: number; errorMessage: string } | null;
}

const THRESHOLD = 80; // px from bottom to consider "at bottom"

/**
 * Rendering window. A long transcript is thousands of DOM nodes (markdown,
 * highlighting, tool cards), and every layout pass pays for all of them —
 * including the composer's per-keystroke autosize reflow. Only the tail is
 * rendered; earlier turns are revealed on demand.
 */
const INITIAL_WINDOW_GROUPS = 20;
const WINDOW_GROWTH_GROUPS = 30;

/**
 * Memoized: the composer draft lives in ChatInterface, so an un-memoized list
 * would re-parse every message's markdown on each keystroke. Props are all
 * primitives or state objects that only change when the conversation does.
 */
export const MessageList = memo(function MessageList({
  messages,
  isLoading,
  isCompacting,
  onEditMessage,
  onSendMessage,
  onQuoteSelection,
  pendingApprovals = [],
  onApprovalResolved,
  sessionId,
  activeTool,
  retry,
}: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [hasJobs, setHasJobs] = useState<boolean | null>(null);

  // Bump on every content change so the selection-quote button can re-check
  // a selection after streaming tokens or a DB reload shift the layout.
  const [selectionVersion, setSelectionVersion] = useState(0);
  useEffect(() => {
    setSelectionVersion((v) => v + 1);
  }, [messages]);

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

  // Group consecutive assistant messages that share a parentMessageId
  const groupedMessages = useMemo(() => groupMessages(messages), [messages]);

  // ── Render window ────────────────────────────────────────────────────────
  // `revealedFrom`: the user asked for earlier turns — that start stays frozen,
  // so a reveal is never undone under a reader's feet.
  // `pinnedStart`: the window held while they are scrolled away from the bottom.
  const [revealedFrom, setRevealedFrom] = useState<number | null>(null);
  const [pinnedStart, setPinnedStart] = useState<number | null>(null);
  const tailStart = Math.max(0, groupedMessages.length - INITIAL_WINDOW_GROUPS);
  const windowStart = revealedFrom ?? (isAtBottom ? tailStart : (pinnedStart ?? tailStart));

  // Track scroll position — unlock auto-scroll when user scrolls up
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distFromBottom <= THRESHOLD;
    setIsAtBottom(atBottom);
    // Reading back: pin the window where the user left it, so arriving turns
    // only append below. Back at the bottom, follow the tail again.
    setPinnedStart(atBottom ? null : windowStart);
  }, [windowStart]);

  const visibleGroups = windowStart > 0 ? groupedMessages.slice(windowStart) : groupedMessages;
  const hiddenMessageCount = useMemo(
    () =>
      groupedMessages
        .slice(0, windowStart)
        .reduce(
          (n, group) => n + (group.type === "assistant-group" ? group.messages.length : 1),
          0,
        ),
    [groupedMessages, windowStart],
  );

  // Auto-scroll to bottom only while streaming and user is near the bottom (locked-in mode).
  // When streaming, user can scroll up to "unlock" — scrolling back to bottom re-locks.
  // Non-streaming message changes (DB reloads, edits) do NOT auto-scroll.
  useEffect(() => {
    if (isLoading && isAtBottom) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, isLoading, isAtBottom]);

  if (messages.length === 0) {
    // While a generation is loading, never show the "Start a conversation"
    // empty state — even a brief flash reads as a broken UI (e.g. during a
    // race between a send and a DB reload, or while a queued message waits
    // for Pi to finish). Show the loading indicator instead.
    if (isLoading) {
      return (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">
              {activeTool?.name ? (
                <>
                  Running <span className="font-medium">{activeTool.name}</span>...
                </>
              ) : (
                "Thinking..."
              )}
            </span>
          </div>
        </div>
      );
    }

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
                className="liquid-glass border-border bg-muted/50 hover:bg-accent/60"
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

  // Check if the last message is a streaming message (streaming-* IDs)
  const lastMsg = messages[messages.length - 1];
  const isStreaming = isLoading && lastMsg?.role === "assistant" && isStreamingMessage(lastMsg);

  return (
    <div ref={containerRef} className="relative flex-1 overflow-y-auto" onScroll={handleScroll}>
      <div className="space-y-4 px-3 py-3 md:space-y-6 md:px-6 md:py-6">
        {hiddenMessageCount > 0 && (
          <div className="flex justify-center">
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground text-xs"
              onClick={() => setRevealedFrom(Math.max(0, windowStart - WINDOW_GROWTH_GROUPS))}
            >
              <History className="mr-1.5 h-3.5 w-3.5" />
              Show {hiddenMessageCount} earlier {hiddenMessageCount === 1 ? "message" : "messages"}
            </Button>
          </div>
        )}
        {visibleGroups.map((group) =>
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
            /* Keyed by the turn's root message: a positional key would remount
               every group whenever the window slides. */
            <AssistantGroup
              key={group.messages[0]!.id}
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
            {retry ? (
              <AlertTriangle className="text-destructive h-4 w-4 shrink-0" />
            ) : (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
            )}
            {retry ? (
              <span className="min-w-0 text-sm break-words">
                <span className="text-destructive font-medium">Provider error</span>{" "}
                <span>
                  {formatProviderError(retry.errorMessage).message} — retrying ({retry.attempt} of{" "}
                  {retry.maxAttempts})...
                </span>
              </span>
            ) : activeTool?.name ? (
              <span className="text-sm">
                Running <span className="font-medium">{activeTool.name}</span>...
              </span>
            ) : (
              <span className="text-sm">Thinking...</span>
            )}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {onQuoteSelection && (
        <SelectionQuoteButton
          containerRef={containerRef}
          onQuote={onQuoteSelection}
          version={selectionVersion}
        />
      )}
    </div>
  );
});

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

  // Real attachments are served via API route; temp ones (optimistic, still
  // in flight) have no object URL we can reconstruct, so they render muted.
  const attachmentViews = message.attachments?.map((att) => ({
    att,
    isImage: att.mimeType.startsWith("image/"),
    url: att.storageId.startsWith("temp-") ? undefined : `/api/chat/attachments/${att.storageId}`,
  }));

  if (isEditing) {
    return (
      <div className="flex flex-row-reverse gap-3">
        {/* Avatar is desktop-only — alignment (right = user) already identifies the speaker on mobile */}
        <div className="liquid-glass-pill hidden h-8 w-8 shrink-0 items-center justify-center rounded-full md:flex">
          <User className="h-4 w-4" />
        </div>
        <div className="max-w-full min-w-0 space-y-2 md:max-w-[85%]">
          {/* Attachments (read-only during edit) */}
          {attachmentViews && attachmentViews.length > 0 && (
            <div className="flex flex-row-reverse flex-wrap items-center gap-2">
              {attachmentViews.map(({ att, isImage, url }) =>
                isImage ? (
                  url ? (
                    <LightboxImage
                      key={att.id}
                      src={url}
                      alt={att.fileName}
                      wrapperClassName="max-w-[60%]"
                      className="ring-border/50 h-24 w-auto rounded-xl object-cover ring-1"
                    />
                  ) : (
                    <div
                      key={att.id}
                      className="bg-muted/50 text-muted-foreground flex h-24 w-32 items-center justify-center rounded-xl text-xs"
                    >
                      {att.fileName}
                    </div>
                  )
                ) : (
                  <AttachmentChip key={att.id} attachment={att} url={url} />
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
      {/* Avatar is desktop-only — alignment (right = user) already identifies the speaker on mobile */}
      <div className="liquid-glass-pill hidden h-8 w-8 shrink-0 items-center justify-center rounded-full md:flex">
        <User className="h-4 w-4" />
      </div>
      <div className="max-w-full min-w-0 space-y-2 md:max-w-[85%]">
        {/* Attachments */}
        {attachmentViews && attachmentViews.length > 0 && (
          <div className="flex flex-row-reverse flex-wrap items-center gap-2">
            {attachmentViews.map(({ att, isImage, url }) =>
              isImage ? (
                url ? (
                  <LightboxImage
                    key={att.id}
                    src={url}
                    alt={att.fileName}
                    wrapperClassName="max-w-[60%]"
                    className="ring-border/50 h-24 w-auto rounded-xl object-cover ring-1"
                  />
                ) : (
                  <div
                    key={att.id}
                    className="bg-muted/50 text-muted-foreground flex h-24 w-32 items-center justify-center rounded-xl text-xs"
                  >
                    {att.fileName}
                  </div>
                )
              ) : (
                <AttachmentChip key={att.id} attachment={att} url={url} />
              ),
            )}
          </div>
        )}

        {/* Text content (only when there's text) */}
        {message.content && (
          <div className="liquid-glass-inner rounded-2xl px-4 py-3" data-quoteable>
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
              className="text-muted-foreground hover:text-foreground opacity-0 transition-opacity group-focus-within/message:opacity-70 group-hover/message:opacity-70 any-pointer-coarse:opacity-70"
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
 * Non-image attachment rendered as a compact chip. Real attachments link to
 * the download endpoint; temp (in-flight) ones render muted without a link.
 */
function AttachmentChip({
  attachment,
  url,
}: {
  attachment: AttachmentData;
  url: string | undefined;
}) {
  const Icon = attachment.mimeType.startsWith("text/") ? FileText : FileIcon;
  const chip = (
    <>
      <div className="bg-muted/50 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
        <Icon className="text-muted-foreground h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="max-w-[140px] truncate text-xs font-medium md:max-w-[200px]">
          {attachment.fileName}
        </p>
        <p className="text-muted-foreground text-[11px]">{formatFileSize(attachment.size)}</p>
      </div>
    </>
  );

  if (!url) {
    return (
      <div className="border-border/30 bg-muted/50 flex items-center gap-2 rounded-xl border px-2.5 py-1.5 opacity-70">
        {chip}
      </div>
    );
  }

  return (
    <a
      href={url}
      download={attachment.fileName}
      aria-label={`Download ${attachment.fileName}`}
      className="border-border/30 bg-muted/50 hover:bg-accent/60 flex items-center gap-2 rounded-xl border px-2.5 py-1.5 transition-colors"
    >
      {chip}
    </a>
  );
}

/**
 * Renders a group of assistant turns as a single visual unit:
 * one avatar, all turns' content flowing naturally, one timestamp at bottom.
 */
function AssistantGroup({ messages, isStreaming }: { messages: Message[]; isStreaming: boolean }) {
  const [expandedThinking, setExpandedThinking] = useState<Set<string>>(new Set());

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

  // Filter out turns with no content at all. An errored turn is kept even when
  // it is empty — the error notice is the only thing there is to show.
  const visibleMessages = messages.filter(
    (m) => m.content || m.thinking || m.errorMessage || (m.toolCalls && m.toolCalls.length > 0),
  );

  if (visibleMessages.length === 0) {
    return null;
  }

  // Use the last message's timestamp
  const timestamp = visibleMessages[visibleMessages.length - 1]?.createdAt;

  // Combined response text for the copy button (empty when no turn has text)
  const copyText = getAssistantCopyText(visibleMessages);

  return (
    <div className="group/message flex gap-3">
      {/* Single avatar for the entire group — desktop-only, saves ~44px per group on mobile */}
      <div className="liquid-glass-pill hidden h-8 w-8 shrink-0 items-center justify-center rounded-full md:flex">
        <Bot className="h-4 w-4" />
      </div>

      {/* All turns' content flowing naturally */}
      <div className="max-w-full min-w-0 space-y-2 md:max-w-[85%]">
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
                    <pre className="text-muted-foreground bg-muted rounded-lg p-3 text-xs leading-relaxed whitespace-pre-wrap dark:bg-white/5">
                      {message.thinking}
                    </pre>
                  </div>
                )}
              </div>
            )}

            {/* Message bubble (only when there's text) */}
            {message.content && (
              <div className="liquid-glass-inner rounded-2xl px-4 py-3" data-quoteable>
                <MarkdownRenderer content={message.content} />
              </div>
            )}

            {/* Provider error (failed turn) */}
            {message.errorMessage && <ProviderErrorNotice error={message.errorMessage} />}

            {/* Streaming indicator for empty current turn */}
            {!message.content &&
              !message.errorMessage &&
              isStreaming &&
              message.id === visibleMessages[visibleMessages.length - 1]?.id && (
                <div className="liquid-glass-inner flex items-center gap-1 rounded-2xl px-4 py-3">
                  <span className="animate-pulse">...</span>
                </div>
              )}

            {/* Tool calls — a turn's parallel calls collapse into one row */}
            {message.toolCalls && message.toolCalls.length > 0 && (
              <div className="space-y-1">
                {message.toolCalls.length > 1 ? (
                  <ToolCallRun toolCalls={message.toolCalls} />
                ) : (
                  <ToolCallView toolCall={message.toolCalls[0]!} />
                )}
              </div>
            )}
          </div>
        ))}

        {/* Single timestamp + copy action for the group */}
        {timestamp && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">
              {new Date(timestamp).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
            {copyText && (
              <CopyButton
                text={copyText}
                label="Copy response"
                className="text-muted-foreground hover:text-foreground opacity-0 transition-opacity group-focus-within/message:opacity-70 group-hover/message:opacity-70 any-pointer-coarse:opacity-70"
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
