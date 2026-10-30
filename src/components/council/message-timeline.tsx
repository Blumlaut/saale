"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { MarkdownRenderer } from "@/components/chat/markdown-renderer";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { CouncilMemberView, CouncilMessageView } from "@/types/council";
import type { CouncilMemberLive } from "./use-council-stream";
import { Bot, Loader2, UserRound, Wrench } from "lucide-react";

export interface MessageTimelineProps {
  councilId: string;
  messages: CouncilMessageView[];
  members: CouncilMemberView[];
  live: Record<string, CouncilMemberLive>;
  loading?: boolean;
}

/** How close to the tail still counts as following it, in pixels. */
const BOTTOM_BAND_PX = 80;

function AuthorChip({ councilId, message }: { councilId: string; message: CouncilMessageView }) {
  if (message.authorKind === "system") {
    return <span className="console-label">notice</span>;
  }
  if (message.authorKind === "user") {
    return (
      <span className="flex items-center gap-1.5">
        <UserRound className="h-3.5 w-3.5" />
        <span className="text-sm font-medium">You</span>
      </span>
    );
  }
  const href =
    message.memberId !== null
      ? `/dashboard/council/${councilId}/member/${message.memberId}`
      : undefined;
  const label = (
    <span className="flex items-center gap-1.5">
      <Bot className="h-3.5 w-3.5" />
      <span className="text-sm font-medium">{message.authorName}</span>
    </span>
  );
  return href ? (
    <Link href={href} className="hover:text-foreground text-foreground/90 transition-colors">
      {label}
    </Link>
  ) : (
    label
  );
}

function MentionChips({
  councilId,
  names,
  memberIds,
}: {
  councilId: string;
  names: string[];
  memberIds: Map<string, string>;
}) {
  if (names.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {names.map((name) => {
        const badge = (
          <Badge variant="secondary" className="bg-primary/10 text-primary text-[10px]">
            @{name}
          </Badge>
        );
        const memberId = memberIds.get(name.toLowerCase());
        return memberId ? (
          <Link
            key={name}
            href={`/dashboard/council/${councilId}/member/${memberId}`}
            aria-label={`Open ${name}'s transcript`}
          >
            {badge}
          </Link>
        ) : (
          <span key={name}>{badge}</span>
        );
      })}
    </span>
  );
}

/** One member's live activity while it works. thinking and tool calls. */
function LiveActivity({ state }: { state: CouncilMemberLive }) {
  const hasThinking = Boolean(state.thinking && state.thinking.trim());
  const hasTools = state.toolCalls.length > 0;
  if (!state.busy && !hasThinking && !hasTools) return null;

  return (
    <div className="liquid-glass-inner rounded-xl border-0 px-3 py-2">
      <div className="flex items-center gap-1.5">
        {state.busy ? (
          <Loader2 className="text-primary h-3 w-3 animate-spin" />
        ) : (
          <Bot className="text-muted-foreground h-3 w-3" />
        )}
        <span className="text-xs font-medium">{state.memberName}</span>
        <span className="text-muted-foreground text-[11px]">
          {state.busy ? "is working…" : "paused"}
        </span>
        {state.round !== null && <span className="console-label ml-auto">round {state.round}</span>}
      </div>

      {hasThinking && (
        <p className="text-muted-foreground mt-1.5 max-h-32 overflow-y-auto text-xs leading-relaxed whitespace-pre-wrap">
          {state.thinking}
        </p>
      )}

      {hasTools && (
        <ul className="mt-1.5 flex flex-col gap-1">
          {state.toolCalls.map((call) => (
            <li
              key={call.toolCallId}
              className="text-muted-foreground flex items-center gap-1.5 text-[11px]"
            >
              <Wrench className="h-3 w-3 shrink-0" />
              <span className="min-w-0 truncate">{call.tool}</span>
              <span className={cn("shrink-0", call.done && call.isError && "text-destructive")}>
                {call.done ? (call.isError ? "failed" : "done") : "…"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The room's timeline: the owner's messages, each member's deliberate posts and
 * the system notices, in sequence order. Only the members' live activity
 * (thinking, tool calls) comes from the SSE stream. the messages themselves
 * are always refetched from the REST route.
 */
export function MessageTimeline({
  councilId,
  messages,
  members,
  live,
  loading,
}: MessageTimelineProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const lastLenRef = useRef(0);
  /** Whether the view was following the tail before the newest messages landed. */
  const atBottomRef = useRef(true);
  const memberIds = new Map(members.map((member) => [member.name.toLowerCase(), member.id]));

  // Follow new messages, but only when the user is already at the bottom. a
  // scroll-back to read should not be yanked away by a live run (this is what
  // the room does most of the time).
  useEffect(() => {
    if (messages.length === lastLenRef.current) return;
    lastLenRef.current = messages.length;
    if (!atBottomRef.current) return;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  if (loading && messages.length === 0) {
    return (
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 md:px-6">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-16 w-full" />
          </div>
        ))}
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-4 py-10 text-center">
        <p className="text-muted-foreground text-sm">The room is empty.</p>
        <p className="text-muted-foreground max-w-sm text-xs">
          Send the council something to work on. Its members will speak here only when they have
          something worth saying.
        </p>
      </div>
    );
  }

  const busy = Object.values(live);

  return (
    <div
      ref={scrollRef}
      onScroll={() => {
        const el = scrollRef.current;
        if (!el) return;
        atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_BAND_PX;
      }}
      className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
        {messages.map((message) => {
          if (message.authorKind === "system") {
            return (
              <div key={message.seq} className="flex justify-center">
                <div className="liquid-glass-inner max-w-full rounded-full border-0 px-3 py-1">
                  <span className="text-muted-foreground text-[11px] whitespace-pre-wrap">
                    {message.content}
                  </span>
                </div>
              </div>
            );
          }

          const isUser = message.authorKind === "user";

          return (
            <div
              key={message.seq}
              className={cn("flex flex-col gap-1", isUser ? "items-end" : "items-start")}
            >
              <div className="flex flex-wrap items-center gap-2">
                <AuthorChip councilId={councilId} message={message} />
                <MentionChips
                  councilId={councilId}
                  names={message.addressedNames}
                  memberIds={memberIds}
                />
              </div>
              <div
                className={cn(
                  "liquid-glass-inner w-fit max-w-full min-w-0 rounded-xl border-0 px-3 py-2",
                  isUser && "bg-accent/40",
                )}
              >
                <MarkdownRenderer content={message.content} className="text-sm" />
              </div>
            </div>
          );
        })}

        {busy.map((state) => (
          <LiveActivity key={state.memberId} state={state} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
