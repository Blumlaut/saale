"use client";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  Mail,
  MailOpen,
  Star,
  ChevronDown,
  ChevronRight,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { useState, useMemo } from "react";
import type { ToolCallData } from "./types";

/** Max characters before truncation. */
const MAX_SUBJECT = 80;
const MAX_PREVIEW = 120;
const MAX_FROM = 30;
const MAX_FOLDER = 16;

/**
 * Structured metadata embedded in mail tool results.
 */
interface MailListMeta {
  type: "mail_list";
  count: number;
  total: number;
  emails: MailEntry[];
}

interface MailSearchMeta {
  type: "mail_search";
  query: string;
  count: number;
  emails: MailEntry[];
}

interface MailReadMeta {
  type: "mail_read";
  count: number;
  emails: MailEntryRead[];
}

interface MailEntry {
  id: string;
  from: string;
  subject: string;
  date: string;
  preview: string;
  read: boolean;
  starred?: boolean;
  folder: string;
  tags?: string[];
}

interface MailEntryRead extends MailEntry {
  to: string;
  bodyText?: string;
  aiSummary?: string;
}

type MailMeta = MailListMeta | MailSearchMeta | MailReadMeta;

/**
 * Extract _saaleMailMeta from a tool result string.
 */
function extractMailMeta(result: string | undefined): MailMeta | null {
  if (!result) return null;

  const looseIdx = result.lastIndexOf('"_saaleMailMeta"');
  if (looseIdx === -1) return null;

  const openBrace = result.lastIndexOf("{", looseIdx);
  if (openBrace === -1) return null;

  let depth = 0;
  let closeBrace = -1;
  for (let i = openBrace; i < result.length; i++) {
    if (result[i] === "{") depth++;
    else if (result[i] === "}") {
      depth--;
      if (depth === 0) {
        closeBrace = i;
        break;
      }
    }
  }
  if (closeBrace === -1) return null;

  try {
    return JSON.parse(result.slice(openBrace, closeBrace + 1))._saaleMailMeta as MailMeta;
  } catch {
    return null;
  }
}

/**
 * Truncate a string with ellipsis.
 */
function truncate(str: string, max: number): string {
  if (!str) return "";
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

/**
 * Format a relative date ("2h ago", "yesterday", "Mar 15").
 */
function formatRelativeDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffH = diffMs / (1000 * 60 * 60);
    const diffD = diffMs / (1000 * 60 * 60 * 24);

    if (diffH < 1) return "just now";
    if (diffH < 24) return `${Math.floor(diffH)}h ago`;
    if (diffD < 2) return "yesterday";
    if (diffD < 7) return `${Math.floor(diffD)}d ago`;

    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

/**
 * Extract email address from "Name <email@example.com>" format.
 */
function extractEmail(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return match?.[1] ?? from;
}

/**
 * Extract display name from "Name <email@example.com>" format.
 */
function extractName(from: string): string {
  const match = from.match(/^(.+?)</);
  return match?.[1]?.trim() ?? "";
}

/**
 * Get a stable color for an email domain (for avatar background).
 */
function getDomainColor(email: string): string {
  const domain = email.split("@")[1] ?? email;
  let hash = 0;
  for (let i = 0; i < domain.length; i++) {
    hash = domain.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 40%, 55%)`;
}

/**
 * Avatar icon showing initials or domain.
 */
function MailAvatar({ from, className }: { from: string; className?: string }) {
  const name = extractName(from);
  const email = extractEmail(from);
  const initials = name
    ? name
        .split(" ")
        .map((w) => w[0] ?? "")
        .join("")
        .slice(0, 2)
        .toUpperCase()
    : (email.split("@")[0] ?? email).slice(0, 2).toUpperCase();
  const color = getDomainColor(email);

  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full text-xs font-medium text-white",
        className,
      )}
      style={{ backgroundColor: color }}
    >
      {initials}
    </div>
  );
}

/**
 * Single email row in a list/search card.
 */
function MailRow({ email }: { email: MailEntry }) {
  const subject = truncate(email.subject || "(no subject)", MAX_SUBJECT);
  const from = truncate(email.from, MAX_FROM);
  const preview = truncate(email.preview, MAX_PREVIEW);
  const date = formatRelativeDate(email.date);
  const folder = truncate(email.folder, MAX_FOLDER);

  return (
    <div className="group flex items-start gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-white/10">
      <MailAvatar from={email.from} className="h-7 w-7 text-[11px]" />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-foreground/90 truncate text-xs font-medium">{from}</span>
          {!email.read && <span className="bg-foreground/20 h-1.5 w-1.5 shrink-0 rounded-full" />}
          {email.starred && <Star className="h-3 w-3 shrink-0 fill-yellow-500 text-yellow-500" />}
        </div>
        <p className="text-foreground/80 truncate text-xs">{subject}</p>
        {preview && <p className="text-muted-foreground/70 line-clamp-1 text-[11px]">{preview}</p>}
        <div className="mt-0.5 flex items-center gap-2">
          <span className="text-muted-foreground/60 text-[10px]">{date}</span>
          <Badge variant="secondary" className="rounded px-1 py-0 text-[10px] font-normal">
            {folder}
          </Badge>
        </div>
      </div>
    </div>
  );
}

/**
 * Mail list/search card.
 */
function MailListCard({
  meta,
  toolCall,
}: {
  meta: MailListMeta | MailSearchMeta;
  toolCall: ToolCallData;
}) {
  const [expanded, setExpanded] = useState(false);
  const isSearch = meta.type === "mail_search";
  const displayQuery = isSearch ? truncate(meta.query, 50) : null;
  const maxVisible = 3;
  const visibleEmails = meta.emails.slice(0, expanded ? meta.emails.length : maxVisible);
  const hasMore = meta.emails.length > maxVisible;

  return (
    <div className="liquid-glass-inner rounded-xl">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2">
        {isSearch ? (
          <MailOpen className="text-muted-foreground h-3 w-3" />
        ) : (
          <Mail className="text-muted-foreground h-3 w-3" />
        )}
        <span className="text-xs font-medium">{isSearch ? "Searched mail" : "Listed mail"}</span>
        {displayQuery && (
          <span className="text-muted-foreground truncate text-xs">
            &ldquo;{displayQuery}&rdquo;
          </span>
        )}
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
          {toolCall.status === "completed" && <Mail className="mr-1 h-2.5 w-2.5" />}
          {(toolCall.status === "error" || toolCall.error) && (
            <AlertCircle className="mr-1 h-2.5 w-2.5" />
          )}
          {meta.count} emails
        </Badge>
      </div>

      {/* Email rows */}
      {meta.emails.length > 0 ? (
        <div className="border-border/30 border-t px-1.5 py-1">
          <div className="space-y-0.5">
            {visibleEmails.map((email) => (
              <MailRow key={email.id} email={email} />
            ))}
          </div>

          {hasMore && !expanded && (
            <button
              onClick={() => setExpanded(true)}
              className="text-muted-foreground hover:text-foreground flex w-full items-center justify-center gap-1 pt-1.5 text-xs"
            >
              <ChevronDown className="h-3 w-3" />
              Show {meta.emails.length - maxVisible} more
            </button>
          )}

          {hasMore && expanded && (
            <button
              onClick={() => setExpanded(false)}
              className="text-muted-foreground hover:text-foreground flex w-full items-center justify-center gap-1 pt-1.5 text-xs"
            >
              <ChevronRight className="h-3 w-3" />
              Show less
            </button>
          )}
        </div>
      ) : (
        <div className="border-border/30 border-t px-3 py-2.5">
          <p className="text-muted-foreground text-xs">No emails found</p>
        </div>
      )}
    </div>
  );
}

/**
 * Mail read card — shows read email(s) summary.
 */
function MailReadCard({ meta, toolCall }: { meta: MailReadMeta; toolCall: ToolCallData }) {
  const email = meta.emails[0];
  if (!email) return null;

  const subject = truncate(email.subject || "(no subject)", MAX_SUBJECT);
  const from = truncate(email.from, MAX_FROM);
  const date = formatRelativeDate(email.date);
  const folder = truncate(email.folder, MAX_FOLDER);

  return (
    <div className="liquid-glass-inner rounded-xl">
      <div className="flex items-center gap-2 px-3 py-2">
        <MailOpen className="text-muted-foreground h-3 w-3" />
        <span className="text-xs font-medium">Read mail</span>
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
          {toolCall.status === "completed" && <MailOpen className="mr-1 h-2.5 w-2.5" />}
          {(toolCall.status === "error" || toolCall.error) && (
            <AlertCircle className="mr-1 h-2.5 w-2.5" />
          )}
          {meta.count} email{meta.count > 1 ? "s" : ""}
        </Badge>
      </div>

      <div className="border-border/30 border-t px-1.5 py-1">
        <div className="flex items-start gap-2.5 rounded-lg px-2.5 py-2">
          <MailAvatar from={email.from} className="h-7 w-7 text-[11px]" />

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="text-foreground/90 truncate text-xs font-medium">{from}</span>
              {email.starred && (
                <Star className="h-3 w-3 shrink-0 fill-yellow-500 text-yellow-500" />
              )}
            </div>
            <p className="text-foreground/80 truncate text-xs">{subject}</p>
            <div className="mt-0.5 flex items-center gap-2">
              <span className="text-muted-foreground/60 text-[10px]">{date}</span>
              <Badge variant="secondary" className="rounded px-1 py-0 text-[10px] font-normal">
                {folder}
              </Badge>
              {meta.count > 1 && (
                <span className="text-muted-foreground/60 text-[10px]">+{meta.count - 1} more</span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Main exported component that routes to the correct card type.
 */
export function MailToolCard({ toolCall }: { toolCall: ToolCallData }) {
  const meta = useMemo(() => extractMailMeta(toolCall.result), [toolCall.result]);

  if (!meta) return null;

  if (meta.type === "mail_read") {
    return <MailReadCard meta={meta} toolCall={toolCall} />;
  }

  return <MailListCard meta={meta} toolCall={toolCall} />;
}
