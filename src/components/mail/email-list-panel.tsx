"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { getTagColor, collectTags } from "@/lib/email/tags";
import { useIsMobile } from "@/hooks/use-mobile";
import { Mail, Search, Star, CheckCheck, RefreshCw, Loader2, ChevronDown, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { InboxEmailAccount, EmailMessage } from "./types";

function formatRelativeDate(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;

  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  return `${Math.floor(months / 12)}y ago`;
}

function getSender(msg: EmailMessage): string {
  if (msg.fromName) return msg.fromName;
  if (msg.fromEmail) return msg.fromEmail;
  return "Unknown Sender";
}

interface EmailListPanelProps {
  messages: EmailMessage[];
  accounts: InboxEmailAccount[];
  activeAccountId: string | null;
  folders: string[];
  folder: string | null;
  tagFilter: string | null;
  search: string;
  debouncedSearch: string;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  selectedId: string | null;
  togglingStar: string | null;
  unreadCount: number;
  syncing: boolean;
  onSearchChange: (value: string) => void;
  onFolderChange: (folder: string | null) => void;
  onTagFilterChange: (tag: string | null) => void;
  onSelectMessage: (msg: EmailMessage) => void;
  onToggleStar: (msg: EmailMessage, e: React.MouseEvent) => void;
  onLoadMore: () => void;
  onSyncAll: () => void;
  onMarkAllRead: () => void;
}

export function EmailListPanel({
  messages,
  accounts,
  activeAccountId,
  folders,
  folder,
  tagFilter,
  search,
  debouncedSearch,
  loading,
  loadingMore,
  hasMore,
  selectedId,
  togglingStar,
  unreadCount,
  syncing,
  onSearchChange,
  onFolderChange,
  onTagFilterChange,
  onSelectMessage,
  onToggleStar,
  onLoadMore,
  onSyncAll,
  onMarkAllRead,
}: EmailListPanelProps) {
  const isMobile = useIsMobile();
  const router = useRouter();
  const [showAccountMenu, setShowAccountMenu] = useState(false);

  const allTags = useMemo(() => collectTags(messages), [messages]);
  const enabledAccounts = useMemo(() => accounts.filter((a) => a.enabled), [accounts]);
  const isSearching = debouncedSearch.length > 0;
  const activeAccount = activeAccountId ? accounts.find((a) => a.id === activeAccountId) : null;

  return (
    <GlassPanel
      className={cn(
        "flex h-full flex-col overflow-hidden border-0",
        isMobile ? "w-full" : "w-full md:w-96",
      )}
    >
      {/* Header */}
      <div className="border-border/30 flex items-center justify-between border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          {enabledAccounts.length > 1 ? (
            <DropdownMenu open={showAccountMenu} onOpenChange={setShowAccountMenu}>
              <DropdownMenuTrigger
                render={
                  <button className="flex items-center gap-1 text-left">
                    <h2 className="truncate text-sm font-semibold">
                      {activeAccount ? activeAccount.email : "All Mail"}
                    </h2>
                    <ChevronDown className="text-muted-foreground h-3 w-3 shrink-0" />
                  </button>
                }
              />
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuItem
                  onClick={() => {
                    setShowAccountMenu(false);
                    router.push("/dashboard/mail");
                  }}
                  className={cn(!activeAccountId && "bg-white/10 dark:bg-white/5")}
                >
                  <Mail className="mr-2 h-4 w-4" />
                  All Mail
                </DropdownMenuItem>
                {enabledAccounts.map((acc) => (
                  <DropdownMenuItem
                    key={acc.id}
                    onClick={() => {
                      setShowAccountMenu(false);
                      router.push(`/dashboard/mail?accountId=${acc.id}`);
                    }}
                    className={cn(activeAccountId === acc.id && "bg-white/10 dark:bg-white/5")}
                  >
                    <Mail className="mr-2 h-4 w-4" />
                    <span className="truncate">{acc.email}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <h2 className="text-sm font-semibold">
              {activeAccount ? activeAccount.email : "All Mail"}
            </h2>
          )}
          {activeAccount && (
            <p className="text-muted-foreground text-[10px]">
              {activeAccount.messageCount} messages
              {activeAccount.lastSyncedAt
                ? ` · ${new Date(activeAccount.lastSyncedAt).toLocaleDateString()}`
                : ""}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1">
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 rounded-full px-2 text-[10px]"
              onClick={onMarkAllRead}
              title="Mark all as read"
            >
              <CheckCheck className="h-3 w-3" />
              <span className="hidden sm:inline">Read</span>
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 rounded-full"
            onClick={onSyncAll}
            disabled={syncing}
            title={activeAccount ? "Sync account" : "Sync all accounts"}
          >
            {syncing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="border-border/30 border-b px-3 py-2">
        <div className="relative">
          <Search className="text-muted-foreground absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2" />
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search emails..."
            className="liquid-glass-inner h-8 rounded-full border-0 bg-transparent pl-9 shadow-none"
          />
          {search && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onSearchChange("")}
              className="absolute top-1/2 right-2 h-4 w-4 -translate-y-1/2 rounded-full p-0 opacity-60 hover:opacity-100"
            >
              <X className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>

      {/* Folder tabs */}
      {folders.length > 0 && (
        <div className="border-border/30 flex overflow-x-auto border-b px-2 py-1">
          <button
            onClick={() => onFolderChange(null)}
            className={cn(
              "shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors",
              !folder ? "liquid-glass-pill" : "text-muted-foreground hover:text-foreground",
            )}
          >
            All
          </button>
          {folders.map((f) => (
            <button
              key={f}
              onClick={() => onFolderChange(f)}
              className={cn(
                "shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors",
                folder === f ? "liquid-glass-pill" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {f === "INBOX" ? "Inbox" : f}
            </button>
          ))}
        </div>
      )}

      {/* Tag filter bar */}
      {allTags.length > 0 && (
        <div className="border-border/30 flex gap-1.5 overflow-x-auto border-b px-3 py-1.5">
          {tagFilter && (
            <button
              onClick={() => onTagFilterChange(null)}
              className="shrink-0 rounded-full bg-white/20 px-2.5 py-0.5 text-xs font-medium transition-colors dark:bg-white/5"
            >
              <X className="mr-0.5 inline h-3 w-3" />
              {tagFilter}
            </button>
          )}
          {allTags.map(({ name, count }) => (
            <button
              key={name}
              onClick={() => onTagFilterChange(tagFilter === name ? null : name)}
              className={cn(
                "shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors",
                tagFilter === name
                  ? getTagColor(name)
                  : "bg-secondary/50 text-muted-foreground hover:bg-secondary hover:text-foreground",
              )}
            >
              {name}
              <span className="ml-1 opacity-60">{count}</span>
            </button>
          ))}
        </div>
      )}

      {/* Message list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex flex-col gap-px py-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="animate-pulse px-4 py-3">
                <div className="flex items-start gap-3">
                  <div className="mt-1 h-3.5 w-3.5 shrink-0 rounded-full bg-white/10" />
                  <div className="flex-1 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="h-3 w-24 rounded bg-white/10" />
                      <div className="h-3 w-12 rounded bg-white/10" />
                    </div>
                    <div className="h-3 w-3/4 rounded bg-white/10" />
                    <div className="h-2.5 w-1/2 rounded bg-white/5" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Mail className="text-muted-foreground/50 mb-2 h-8 w-8" />
            <p className="text-muted-foreground text-sm">
              {accounts.length === 0
                ? "Connect an email account to get started"
                : isSearching
                  ? "No emails match your search"
                  : "No emails here"}
            </p>
          </div>
        ) : (
          <>
            {messages.map((msg, i) => {
              const msgAccount = accounts.find((a) => a.id === msg.accountId);

              return (
                <div key={msg.id}>
                  <button
                    className={cn(
                      "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-white/10 dark:hover:bg-white/5",
                      selectedId === msg.id && "bg-white/15 dark:bg-white/5",
                    )}
                    onClick={() => onSelectMessage(msg)}
                  >
                    <div onClick={(e) => onToggleStar(msg, e)} className="cursor-pointer">
                      <Star
                        className={cn(
                          "mt-0.5 h-3.5 w-3.5 shrink-0 transition-colors",
                          msg.isStarred
                            ? "fill-yellow-400 text-yellow-400"
                            : "text-muted-foreground/30 hover:text-foreground/60",
                          togglingStar === msg.id && "opacity-50",
                        )}
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className={cn("truncate text-sm", !msg.isRead && "font-semibold")}>
                            {getSender(msg)}
                          </span>
                          {!activeAccountId && msgAccount && (
                            <span className="text-muted-foreground shrink-0 text-[10px]">
                              {msgAccount.email}
                            </span>
                          )}
                        </div>
                        <span className="text-muted-foreground ml-2 shrink-0 text-xs">
                          {formatRelativeDate(msg.date)}
                        </span>
                      </div>
                      <div className={cn("truncate text-sm", !msg.isRead && "font-medium")}>
                        {msg.subject || "(no subject)"}
                      </div>
                      <div className="text-muted-foreground truncate text-xs">
                        {msg.bodyPreview || "(body not loaded)"}
                      </div>
                      {msg.tags.length > 0 && (
                        <div className="mt-1 flex gap-1">
                          {msg.tags.slice(0, 3).map((tag) => (
                            <Badge
                              key={tag}
                              className={cn(
                                "rounded-full px-1.5 py-0 text-[10px]",
                                getTagColor(tag),
                              )}
                            >
                              {tag}
                            </Badge>
                          ))}
                          {msg.tags.length > 3 && (
                            <Badge
                              variant="secondary"
                              className="rounded-full px-1.5 py-0 text-[10px]"
                            >
                              +{msg.tags.length - 3}
                            </Badge>
                          )}
                        </div>
                      )}
                    </div>
                  </button>
                  {i < messages.length - 1 && <Separator className="px-4" />}
                </div>
              );
            })}

            {/* Load more trigger */}
            {hasMore && (
              <div className="flex items-center justify-center py-4">
                {loadingMore ? (
                  <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onLoadMore}
                    className="rounded-full px-3 py-1 text-xs"
                  >
                    Load more
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </GlassPanel>
  );
}
