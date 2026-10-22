"use client";

import {
  memo,
  forwardRef,
  useEffect,
  useRef,
  useState,
  useMemo,
  useCallback,
  useImperativeHandle,
} from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { downloadFile } from "@/lib/download";
import { MarkdownRenderer } from "./markdown-renderer";
import { LightboxImage } from "./image-lightbox";
import { ApprovalMessage } from "./approval-message";
import { CompactionMessage } from "./compaction-message";
import { CopyButton } from "./copy-button";
import { SelectionQuoteButton } from "./selection-quote-button";
import { ToolCallGroup } from "./tool-call-group";
import { CompactActivity } from "./compact-activity";
import { compactBlocks } from "./compact-blocks";
import { splitToolCalls } from "./tool-cards";
import { ToolCallView } from "./tool-call-view";
import { toolMark } from "./tool-marks";
import { ProviderErrorNotice } from "./provider-error-notice";
import { formatProviderError } from "@/lib/pi/provider-error";
import { groupMessages, type MessageGroup } from "@/lib/chat/group-messages";
import { stripAttachmentPromptText } from "@/lib/strip-attachment-prompt";
import { getAssistantCopyText } from "@/lib/chat/copy-response";
import { isStreamingMessage } from "@/lib/chat/message-factories";
import { formatFileSize, cn } from "@/lib/utils";
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

export interface MessageListHandle {
  /** Jump to the latest message and re-arm auto-scroll. */
  enableAutoScroll: () => void;
}

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
  /**
   * Condense each turn's reasoning and tool calls into one line each, instead
   * of a card and a thinking block per step (the user's Appearance setting).
   * Defaults to the step-by-step transcript.
   */
  compactActivity?: boolean;
}

const BOTTOM_EPSILON_PX = 1; // px from the tail that still counts as the tail
/** How close to the tail, while scrolling *toward* it, counts as arriving. */
const RETURN_BAND_PX = 80;
/** Touch drag distance that counts as a deliberate scroll, not a tap. */
const TOUCH_SLOP_PX = 4;

/** The scroll offset that pins a container to its tail. */
const tailOffset = (el: HTMLElement) => Math.max(0, el.scrollHeight - el.clientHeight);

/**
 * Is the view sitting on the tail (within `band`)?
 *
 * Deliberately tight by default. A follow leaves the view clamped exactly at the
 * tail, so anything further away was moved by the user. and the old 80px "at
 * bottom" band is what let auto-scroll re-arm itself from the user's own scroll
 * event and pull a wheel tick straight back down.
 */
const atTail = (el: HTMLElement, band = BOTTOM_EPSILON_PX) => tailOffset(el) - el.scrollTop <= band;

/**
 * Rendering window. A long transcript is thousands of DOM nodes (markdown,
 * highlighting, tool cards), and every layout pass pays for all of them
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
export const MessageList = memo(
  forwardRef<MessageListHandle, MessageListProps>(function MessageList(
    {
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
      compactActivity = false,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const bottomRef = useRef<HTMLDivElement>(null);
    const [isAtBottom, setIsAtBottom] = useState(true);
    // Auto-scroll is armed until the user scrolls up away from the tail.
    // Re-armed by scrolling back down, the jump-to-bottom button, and
    // enableAutoScroll (send, approval). Kept separate from isAtBottom,
    // which is purely scroll-derived and also selects the render window.
    const [autoScroll, setAutoScroll] = useState(true);
    /** `autoScroll` for the follow effect and the handlers below. They must read
     * it synchronously: a token can commit in the same frame as the user's wheel,
     * and a stale `true` would drag the view back down over them. */
    const autoScrollRef = useRef(true);
    const armAutoScroll = useCallback((armed: boolean) => {
      autoScrollRef.current = armed;
      setAutoScroll(armed);
    }, []);
    /** The position the last scroll event reported. Every movement reaches us
     * as a scroll event. ours, the user's, the browser's. and unlike a read
     * after a programmatic scroll, a dispatched event is never stale. */
    const observedTopRef = useRef(0);
    const touchStartYRef = useRef<number | null>(null);
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
    // `revealedFrom`: the user asked for earlier turns. that start stays frozen,
    // so a reveal is never undone under a reader's feet.
    // `pinnedStart`: the window held while they are scrolled away from the bottom.
    const [revealedFrom, setRevealedFrom] = useState<number | null>(null);
    const [pinnedStart, setPinnedStart] = useState<number | null>(null);
    const tailStart = Math.max(0, groupedMessages.length - INITIAL_WINDOW_GROUPS);
    const windowStart = revealedFrom ?? (isAtBottom ? tailStart : (pinnedStart ?? tailStart));

    // Track scroll position. arm/disarm auto-scroll with the scroll position
    const handleScroll = useCallback(() => {
      const el = containerRef.current;
      if (!el) return;
      const atBottom = atTail(el);
      // A follow only ever moves the view *down*, so a position above the last
      // one we saw cannot be ours: the user dragged the scrollbar, pressed a
      // key, or the window changed under them. Their position wins.
      const movedUp = el.scrollTop < observedTopRef.current - BOTTOM_EPSILON_PX;
      const movedDown = el.scrollTop > observedTopRef.current + BOTTOM_EPSILON_PX;
      observedTopRef.current = el.scrollTop;
      setIsAtBottom(atBottom);
      // Reading back: pin the window where the user left it, so arriving turns
      // only append below. Back at the bottom, follow the tail again.
      setPinnedStart(atBottom ? null : windowStart);
      if (atBottom || (movedDown && atTail(el, RETURN_BAND_PX))) {
        // On the tail, or scrolling back down into it: following is what they
        // want. Gated on direction, so a wheel *up* can never re-arm this way.
        armAutoScroll(true);
      } else if (movedUp) {
        armAutoScroll(false);
      }
    }, [windowStart, armAutoScroll]);

    // Input drives the view, never the other way round: wheel, touch and keys
    // release auto-scroll as they happen, before the follow effect can pull the
    // view back to the tail. Scrolling back down to the tail re-arms it.
    const handleWheel = useCallback(
      (e: React.WheelEvent) => {
        const el = containerRef.current;
        if (!el) return;
        // `scrollTop > 0`: a transcript that fits cannot scroll up, so an
        // upward wheel there is not the user leaving the tail.
        if (e.deltaY < 0) {
          if (el.scrollTop > 0) armAutoScroll(false);
        } else if (e.deltaY > 0 && atTail(el)) {
          armAutoScroll(true);
        }
      },
      [armAutoScroll],
    );

    const handlePointerDown = useCallback(
      (e: React.PointerEvent) => {
        const el = containerRef.current;
        if (!el) return;
        // A press in the scrollbar gutter (inside the container's box, outside
        // its content area) starts a thumb drag. a scroll input like any other.
        const gutter = el.offsetWidth - el.clientWidth;
        if (gutter > 0 && e.nativeEvent.offsetX >= el.clientWidth) armAutoScroll(false);
      },
      [armAutoScroll],
    );

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        const target = e.target as HTMLElement | null;
        // Keys typed into a message's editor are not a scroll.
        if (target?.closest("input, textarea, [contenteditable='true']")) return;
        if (e.key === "PageUp" || e.key === "ArrowUp" || e.key === "Home") {
          armAutoScroll(false);
        }
      },
      [armAutoScroll],
    );

    const handleTouchStart = useCallback((e: React.TouchEvent) => {
      touchStartYRef.current = e.touches[0]?.clientY ?? null;
    }, []);

    const handleTouchMove = useCallback(
      (e: React.TouchEvent) => {
        const el = containerRef.current;
        const start = touchStartYRef.current;
        const y = e.touches[0]?.clientY;
        if (start === null || y === undefined || !el) return;
        if (y - start > TOUCH_SLOP_PX) {
          // Finger dragged down pulls earlier turns back into view: reading back.
          if (el.scrollTop > 0) armAutoScroll(false);
        } else if (start - y > TOUCH_SLOP_PX && atTail(el)) {
          armAutoScroll(true);
        }
      },
      [armAutoScroll],
    );

    // Jump to the tail and re-arm auto-scroll (button click, send, approval).
    const jumpToBottom = useCallback(() => {
      const el = containerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
      // Set state directly too: a programmatic scroll may not emit a scroll
      // event (e.g. already at the bottom), and the button must hide now.
      setIsAtBottom(true);
      setPinnedStart(null);
      armAutoScroll(true);
    }, [armAutoScroll]);

    useImperativeHandle(ref, () => ({ enableAutoScroll: jumpToBottom }), [jumpToBottom]);

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

    // Follow the tail on every content change while auto-scroll is armed.
    // Scrolling up disarms it (reading position is preserved through reloads);
    // the jump button, a send, or an approval re-arms it.
    // Instant, not smooth. queued smooth scrolls lag a fast token stream,
    // which is what made the old auto-scroll feel flaky.
    useEffect(() => {
      const el = containerRef.current;
      if (!el || !autoScrollRef.current) return;
      bottomRef.current?.scrollIntoView({ behavior: "auto" });
    }, [messages, autoScroll]);

    if (messages.length === 0) {
      // While a generation is loading, never show the "Start a conversation"
      // empty state. even a brief flash reads as a broken UI (e.g. during a
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
                : "Ask anything. I can search emails, manage files, and run jobs."}
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

    // The run in flight, if any: the last assistant group while a response is
    // still coming. Deliberately group-scoped and not derived from a streaming
    // message id. a turn keeps running while its tools do, and its message is
    // saved (losing the `streaming-` id) before those tools ever report back.
    const busyGroupKey = isLoading ? lastAssistantGroupId(visibleGroups) : null;

    return (
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={containerRef}
          className="flex-1 overflow-y-auto"
          onScroll={handleScroll}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onKeyDown={handleKeyDown}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
        >
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
                  Show {hiddenMessageCount} earlier{" "}
                  {hiddenMessageCount === 1 ? "message" : "messages"}
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
                  compactActivity={compactActivity}
                  isBusy={busyGroupKey !== null && group.messages[0]!.id === busyGroupKey}
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

            {/* Waiting on the LLM or a tool result needs no indicator of its
              own. the composer's stop button spins while the run is in
              flight. The retry notice is kept: a failing provider call is the
              one state the spinner can't tell. */}
            {isLoading && !isStreaming && retry && (
              <div className="text-muted-foreground flex items-center gap-2">
                <AlertTriangle className="text-destructive h-4 w-4 shrink-0" />
                <span className="min-w-0 text-sm break-words">
                  <span className="text-destructive font-medium">Provider error</span>{" "}
                  <span>
                    {formatProviderError(retry.errorMessage).message}. retrying ({retry.attempt} of{" "}
                    {retry.maxAttempts})...
                  </span>
                </span>
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

        {/* Jump to the tail. pinned to the message window, visible only while
          reading earlier turns */}
        <Button
          type="button"
          size="icon"
          variant="outline"
          aria-label="Jump to the latest message"
          aria-hidden={isAtBottom}
          tabIndex={isAtBottom ? -1 : 0}
          title="Jump to the latest message"
          onClick={jumpToBottom}
          className={cn(
            "absolute right-3 bottom-3 z-10 h-8 w-8 transition-opacity duration-150 md:right-4 md:bottom-4",
            isAtBottom ? "pointer-events-none opacity-0" : "opacity-100",
          )}
        >
          <ChevronDown className="h-4 w-4" />
        </Button>
      </div>
    );
  }),
);

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

  // The server appends a file-reference line per attachment so the model can
  // find the file. redundant here, since the attachments render on their own.
  const displayContent = message.attachments?.length
    ? stripAttachmentPromptText(message.content)
    : message.content;

  if (isEditing) {
    return (
      <div className="flex flex-row-reverse gap-3">
        {/* Avatar is desktop-only. alignment (right = user) already identifies the speaker on mobile */}
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
      {/* Avatar is desktop-only. alignment (right = user) already identifies the speaker on mobile */}
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
        {displayContent && (
          <div className="liquid-glass-inner rounded-2xl px-4 py-3" data-quoteable>
            <div className="text-sm whitespace-pre-wrap">{displayContent}</div>
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
 * Non-image attachment rendered as a compact chip. Real attachments download
 * their file; temp (in-flight) ones render muted without a control.
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
    <button
      type="button"
      onClick={() => downloadFile(url)}
      aria-label={`Download ${attachment.fileName}`}
      className="border-border/30 bg-muted/50 hover:bg-accent/60 flex items-center gap-2 rounded-xl border px-2.5 py-1.5 transition-colors"
    >
      {chip}
    </button>
  );
}

/** The last assistant group of a transcript. the turn a run is working on. */
function lastAssistantGroupId(groups: readonly MessageGroup[]): string | null {
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i]!;
    if (group.type === "assistant-group") return group.messages[0]?.id ?? null;
  }
  return null;
}

/** One step's prose: the answer bubble, a provider error, or progress dots. */
function AssistantMessageBody({
  message,
  isStreaming,
}: {
  message: Message;
  isStreaming: boolean;
}) {
  return (
    <>
      {/* Message bubble (only when there's text) */}
      {message.content && (
        <div className="liquid-glass-inner rounded-2xl px-4 py-3" data-quoteable>
          <MarkdownRenderer content={message.content} />
        </div>
      )}

      {/* Provider error (failed turn) */}
      {message.errorMessage && <ProviderErrorNotice error={message.errorMessage} />}

      {/* Streaming indicator for empty current turn */}
      {!message.content && !message.errorMessage && isStreaming && (
        <div className="liquid-glass-inner flex items-center gap-1 rounded-2xl px-4 py-3">
          <span className="animate-pulse">...</span>
        </div>
      )}
    </>
  );
}

/**
 * Renders a group of assistant turns as a single visual unit:
 * one avatar, all turns' content flowing naturally, one timestamp at bottom.
 *
 * `compactActivity` replaces the per-step transcript. a thinking block and a
 * tool card for every step the turn took. with one condensed line each. See
 * `CompactActivity`.
 */
function AssistantGroup({
  messages,
  isBusy,
  compactActivity,
}: {
  messages: Message[];
  /** The run is still working on this group. see `busyGroupKey`. */
  isBusy: boolean;
  compactActivity: boolean;
}) {
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
  // it is empty. the error notice is the only thing there is to show.
  const visibleMessages = useMemo(
    () =>
      messages.filter(
        (m) => m.content || m.thinking || m.errorMessage || (m.toolCalls && m.toolCalls.length > 0),
      ),
    [messages],
  );

  if (visibleMessages.length === 0) {
    return null;
  }

  // Use the last message's timestamp
  const timestamp = visibleMessages[visibleMessages.length - 1]?.createdAt;

  // Combined response text for the copy button (empty when no turn has text)
  const copyText = getAssistantCopyText(visibleMessages);

  // The turn the run is working on, if any. Only its rows report progress, and
  // the flag is turn-scoped rather than per token. otherwise it drops every
  // time a step pauses to run a tool, and the row blinks.
  const activeTurnId = isBusy ? (visibleMessages[visibleMessages.length - 1]?.id ?? null) : null;

  return (
    <div className="group/message flex gap-3">
      {/* Single avatar for the entire group. desktop-only, saves ~44px per group on mobile */}
      <div className="liquid-glass-pill hidden h-8 w-8 shrink-0 items-center justify-center rounded-full md:flex">
        <Bot className="h-4 w-4" />
      </div>

      {/* All turns' content flowing naturally */}
      <div className="max-w-full min-w-0 space-y-2 md:max-w-[85%]">
        {compactActivity
          ? compactBlocks(visibleMessages, splitToolCalls).map((block) =>
              block.kind === "activity" ? (
                <CompactActivity
                  key={block.key}
                  reasoning={block.steps.flatMap((step) => (step.thinking ? [step.thinking] : []))}
                  toolCalls={block.steps.flatMap((step) => step.work)}
                  isActive={block.steps.some((step) => step.id === activeTurnId)}
                  renderCall={ToolCallView}
                  markOf={toolMark}
                />
              ) : block.kind === "attachments" ? (
                <ToolCallGroup key={block.key} toolCalls={block.toolCalls} />
              ) : (
                <AssistantMessageBody
                  key={block.key}
                  message={block.message}
                  isStreaming={block.message.id === activeTurnId}
                />
              ),
            )
          : visibleMessages.map((message) => (
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
                        {message.id === activeTurnId ? "Thinking..." : "Thought process"}
                      </span>
                      {message.id === activeTurnId && (
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

                <AssistantMessageBody message={message} isStreaming={message.id === activeTurnId} />

                {/* Tool calls. the turn's work collapses, its shared files do not */}
                {message.toolCalls && message.toolCalls.length > 0 && (
                  <ToolCallGroup toolCalls={message.toolCalls} />
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
