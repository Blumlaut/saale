"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { getTagColor, collectTags } from "@/lib/email/tags";
import { fetchJson, patchJson } from "@/lib/http";
import { parseAddresses } from "@/lib/email/utils";
import type { EmailAccount } from "@/types/shared";
import {
  Mail,
  Search,
  Star,
  RefreshCw,
  Loader2,
  Archive,
  Trash2,
  Plus,
  X,
  ChevronLeft,
  Reply,
  ReplyAll,
  Forward,
  MoreHorizontal,
  Eye,
  EyeOff,
  CheckCheck,
  ChevronDown,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { formatDistanceToNow, format } from "date-fns";
import { useIsMobile } from "@/hooks/use-mobile";
import { ReplyForwardSheet } from "@/components/mail/reply-forward-sheet";
import { toast } from "sonner";

interface EmailMessage {
  id: string;
  uid: string;
  fromName: string | null;
  fromEmail: string;
  to: unknown;
  subject: string;
  date: string;
  bodyPreview: string;
  bodyHtml: string | null;
  bodyText: string | null;
  isRead: boolean;
  isStarred: boolean;
  folder: string;
  tags: string[];
  accountId: string;
}

interface InboxEmailAccount extends EmailAccount {
  remoteFolders: string[];
}

function getSender(msg: EmailMessage): string {
  if (msg.fromName) return msg.fromName;
  if (msg.fromEmail) return msg.fromEmail;
  return "Unknown Sender";
}

/** Shared toolbar for desktop detail and mobile sheet */
function MessageToolbar({ message, onRefresh }: { message: EmailMessage; onRefresh: () => void }) {
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyMode, setReplyMode] = useState<"reply" | "reply_all" | "forward">("reply");

  const openReply = (mode: "reply" | "reply_all" | "forward") => {
    setReplyMode(mode);
    setReplyOpen(true);
  };

  const handleTrash = async () => {
    try {
      await patchJson(`/api/email/messages/${message.id}`, { action: "trash" });
      toast.success("Email moved to trash");
      onRefresh();
    } catch {
      toast.error("Failed to trash email");
    }
  };

  const handleArchive = async () => {
    try {
      await patchJson(`/api/email/messages/${message.id}`, { action: "archive" });
      toast.success("Email archived");
      onRefresh();
    } catch {
      toast.error("Failed to archive email");
    }
  };

  const handleToggleRead = async () => {
    try {
      await patchJson(`/api/email/messages/${message.id}`, { isRead: !message.isRead });
      toast.success(message.isRead ? "Marked as unread" : "Marked as read");
      onRefresh();
    } catch {
      toast.error("Failed to update read status");
    }
  };

  const toolbarButtons = (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5 rounded-full text-xs"
        onClick={() => openReply("reply")}
        title="Reply"
      >
        <Reply className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Reply</span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5 rounded-full text-xs"
        onClick={() => openReply("reply_all")}
        title="Reply All"
      >
        <ReplyAll className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">All</span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5 rounded-full text-xs"
        onClick={() => openReply("forward")}
        title="Forward"
      >
        <Forward className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Forward</span>
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger>
          <span
            className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors hover:bg-white/10 dark:hover:bg-white/5"
            title="More actions"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onClick={handleArchive}>
            <Archive className="mr-2 h-4 w-4" />
            Archive
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleTrash}>
            <Trash2 className="mr-2 h-4 w-4" />
            Move to Trash
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleToggleRead}>
            {message.isRead ? (
              <>
                <EyeOff className="mr-2 h-4 w-4" />
                Mark Unread
              </>
            ) : (
              <>
                <Eye className="mr-2 h-4 w-4" />
                Mark Read
              </>
            )}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={async () => {
              const newStarred = !message.isStarred;
              try {
                await patchJson(`/api/email/messages/${message.id}`, { isStarred: newStarred });
                onRefresh();
              } catch {
                toast.error("Failed to update star");
              }
            }}
          >
            <Star className="mr-2 h-4 w-4" />
            {message.isStarred ? "Unstar" : "Star"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  return (
    <>
      <div className="flex items-center gap-1">{toolbarButtons}</div>
      <ReplyForwardSheet
        open={replyOpen}
        onOpenChange={setReplyOpen}
        mode={replyMode}
        originalMessage={{
          id: message.id,
          fromName: message.fromName,
          fromEmail: message.fromEmail,
          to: message.to,
          subject: message.subject,
          bodyText: message.bodyText,
          bodyPreview: message.bodyPreview,
          accountId: message.accountId,
        }}
        onSuccess={onRefresh}
      />
    </>
  );
}

export function Inbox() {
  const searchParams = useSearchParams();
  const urlAccountId = searchParams.get("accountId");

  const [messages, setMessages] = useState<EmailMessage[]>([]);
  const [accounts, setAccounts] = useState<InboxEmailAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedMsg, setSelectedMsg] = useState<EmailMessage | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [togglingStar, setTogglingStar] = useState<string | null>(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const isMobile = useIsMobile();
  const loadMoreRef = useRef<HTMLDivElement>(null);

  const activeAccountId = urlAccountId ?? null;
  const LIMIT = 25;

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const loadAccounts = useCallback(async () => {
    try {
      const data = await fetchJson<{ accounts: InboxEmailAccount[] }>("/api/email/accounts");
      setAccounts(data.accounts);
    } catch {
      // Ignore
    }
  }, []);

  const loadMessages = useCallback(
    async (append = false) => {
      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
        setOffset(0);
      }
      try {
        const currentOffset = append ? offset : 0;
        const params = new URLSearchParams({
          limit: String(LIMIT),
          offset: String(currentOffset),
        });
        if (activeAccountId) params.set("accountId", activeAccountId);
        if (folder) params.set("folder", folder);
        if (debouncedSearch) params.set("search", debouncedSearch);
        if (tagFilter) params.set("tag", tagFilter);

        const data = await fetchJson<{
          messages: EmailMessage[];
          total: number;
          hasMore: boolean;
        }>(`/api/email/messages?${params}`);

        if (append) {
          setMessages((prev) => [...prev, ...data.messages]);
          setOffset(currentOffset + data.messages.length);
        } else {
          setMessages(data.messages);
          setOffset(data.messages.length);
        }
        setHasMore(data.hasMore ?? false);
      } catch {
        // Ignore
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [activeAccountId, folder, debouncedSearch, tagFilter, offset],
  );

  // Ref to always have the latest loadMessages without triggering re-renders
  const loadMessagesRef = useRef(loadMessages);
  useEffect(() => {
    loadMessagesRef.current = loadMessages;
  }, [loadMessages]);

  // Guard against concurrent load more requests
  const isAppending = useRef(false);

  // Stable refresh function
  const refreshAll = useCallback(async () => {
    await loadAccounts();
    await loadMessagesRef.current(false);
  }, [loadAccounts]);

  // Initial load + filter changes
  useEffect(() => {
    loadAccounts();
    loadMessagesRef.current(false);
  }, [activeAccountId, folder, tagFilter, debouncedSearch, loadAccounts]);

  // mail:refresh event listener
  useEffect(() => {
    const handler = () => {
      loadAccounts();
      loadMessagesRef.current(false);
    };
    window.addEventListener("mail:refresh", handler);
    return () => window.removeEventListener("mail:refresh", handler);
  }, [loadAccounts]);

  // Infinite scroll observer
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isAppending.current) {
          isAppending.current = true;
          loadMessagesRef.current(true).finally(() => {
            isAppending.current = false;
          });
        }
      },
      { rootMargin: "100px" },
    );

    const el = loadMoreRef.current;
    if (el && hasMore) {
      observer.observe(el);
    }
    return () => observer.disconnect();
  }, [hasMore]);

  const handleSyncAll = async () => {
    setSyncing(true);
    try {
      const enabledAccounts = accounts.filter((a) => a.enabled);
      await Promise.all(
        enabledAccounts.map((acc) =>
          fetch(`/api/email/accounts/${acc.id}/sync`, { method: "POST" }),
        ),
      );
      await refreshAll();
      toast.success("Sync complete");
    } catch {
      toast.error("Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const handleSelect = async (msg: EmailMessage) => {
    setSelectedId(msg.id);
    setSelectedMsg(msg);
    if (isMobile) {
      setMobileDetailOpen(true);
    }
    if (!msg.isRead) {
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, isRead: true } : m)));
      setSelectedMsg((prev) => (prev ? { ...prev, isRead: true } : prev));
      // Persist to server
      patchJson(`/api/email/messages/${msg.id}`, { isRead: true }).catch(() => {
        // Revert local state on failure
        setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, isRead: false } : m)));
        setSelectedMsg((prev) => (prev ? { ...prev, isRead: false } : prev));
      });
    }
  };

  const handleToggleStar = async (msg: EmailMessage, e: React.MouseEvent) => {
    e.stopPropagation();
    const newStarred = !msg.isStarred;
    const msgId = msg.id;
    setTogglingStar(msgId);

    setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, isStarred: newStarred } : m)));
    if (selectedMsg?.id === msgId) {
      setSelectedMsg((prev) => (prev ? { ...prev, isStarred: newStarred } : prev));
    }

    try {
      await patchJson(`/api/email/messages/${msgId}`, { isStarred: newStarred });
    } catch {
      setMessages((prev) =>
        prev.map((m) => (m.id === msgId ? { ...m, isStarred: !newStarred } : m)),
      );
      if (selectedMsg?.id === msgId) {
        setSelectedMsg((prev) => (prev ? { ...prev, isStarred: !newStarred } : prev));
      }
    } finally {
      setTogglingStar(null);
    }
  };

  const handleMarkAllRead = async () => {
    const unreadIds = messages.filter((m) => !m.isRead).map((m) => m.id);
    if (unreadIds.length === 0) return;

    try {
      await Promise.all(
        unreadIds.map((id) => patchJson(`/api/email/messages/${id}`, { isRead: true })),
      );
      setMessages((prev) => prev.map((m) => ({ ...m, isRead: true })));
      toast.success(`Marked ${unreadIds.length} as read`);
    } catch {
      toast.error("Failed to mark all as read");
    }
  };

  const selectedMessage = selectedMsg;

  const allTags = useMemo(() => collectTags(messages), [messages]);

  // Tag management
  const [addingTag, setAddingTag] = useState(false);
  const [newTagInput, setNewTagInput] = useState("");

  const handleAddTag = async (msgId: string, tag: string) => {
    const trimmed = tag.trim();
    if (!trimmed) return;
    const msg = messages.find((m) => m.id === msgId);
    if (!msg || msg.tags.includes(trimmed)) return;

    const newTags = [...msg.tags, trimmed];
    try {
      await patchJson(`/api/email/messages/${msgId}`, { tags: newTags });
      setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, tags: newTags } : m)));
      if (selectedMsg?.id === msgId) {
        setSelectedMsg((prev) => (prev ? { ...prev, tags: newTags } : prev));
      }
    } catch {
      // Ignore
    }
    setAddingTag(false);
    setNewTagInput("");
  };

  const handleRemoveTag = async (msgId: string, tag: string) => {
    const msg = messages.find((m) => m.id === msgId);
    if (!msg) return;

    const newTags = msg.tags.filter((t) => t !== tag);
    try {
      await patchJson(`/api/email/messages/${msgId}`, { tags: newTags });
      setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, tags: newTags } : m)));
      if (selectedMsg?.id === msgId) {
        setSelectedMsg((prev) => (prev ? { ...prev, tags: newTags } : prev));
      }
    } catch {
      // Ignore
    }
  };

  const activeAccount = activeAccountId ? accounts.find((a) => a.id === activeAccountId) : null;

  const availableFolders = useMemo(() => {
    if (activeAccount) {
      const remote = activeAccount.remoteFolders.filter((f) => f.length > 0);
      if (remote.length > 0) {
        const inboxLike = remote.filter((f) => f.toUpperCase() === "INBOX");
        const rest = remote.filter((f) => f.toUpperCase() !== "INBOX").sort();
        return [...inboxLike, ...rest];
      }
      return (activeAccount.folders ?? []).sort();
    }

    const folderSet = new Set<string>();
    for (const acc of accounts.filter((a) => a.enabled)) {
      for (const f of acc.folders ?? []) {
        folderSet.add(f);
      }
    }
    if (folderSet.size === 0) return [];
    const folders = Array.from(folderSet);
    const inboxIdx = folders.findIndex((f) => f === "INBOX");
    if (inboxIdx > 0) {
      const inboxFolder = folders.splice(inboxIdx, 1)[0];
      if (inboxFolder) folders.unshift(inboxFolder);
    }
    return folders;
  }, [activeAccount, accounts]);

  const unreadCount = useMemo(() => messages.filter((m) => !m.isRead).length, [messages]);
  const enabledAccounts = useMemo(() => accounts.filter((a) => a.enabled), [accounts]);

  const isSearching = debouncedSearch.length > 0;

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-4 md:h-[calc(100vh-7rem)]">
      {/* Mail list */}
      <GlassPanel className="flex h-full w-full flex-col overflow-hidden border-0 md:w-96">
        {/* Header */}
        <div className="border-border/30 flex items-center justify-between border-b px-4 py-3">
          <div className="min-w-0 flex-1">
            {/* Account switcher */}
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
                      window.location.href = "/dashboard/mail";
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
                        window.location.href = `/dashboard/mail?accountId=${acc.id}`;
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
                onClick={handleMarkAllRead}
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
              onClick={handleSyncAll}
              disabled={syncing}
              title="Sync all accounts"
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
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search emails..."
              className="liquid-glass-inner h-8 rounded-full border-0 bg-transparent pl-9 shadow-none"
            />
            {search && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setSearch("")}
                className="absolute top-1/2 right-2 h-4 w-4 -translate-y-1/2 rounded-full p-0 opacity-60 hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </Button>
            )}
          </div>
        </div>

        {/* Folder tabs */}
        {availableFolders.length > 0 && (
          <div className="border-border/30 flex overflow-x-auto border-b px-2 py-1">
            <button
              onClick={() => {
                setFolder(null);
                setSelectedId(null);
                setSelectedMsg(null);
              }}
              className={cn(
                "shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors",
                !folder ? "liquid-glass-pill" : "text-muted-foreground hover:text-foreground",
              )}
            >
              All
            </button>
            {availableFolders.map((f) => (
              <button
                key={f}
                onClick={() => {
                  setFolder(f);
                  setSelectedId(null);
                  setSelectedMsg(null);
                }}
                className={cn(
                  "shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors",
                  folder === f
                    ? "liquid-glass-pill"
                    : "text-muted-foreground hover:text-foreground",
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
                onClick={() => setTagFilter(null)}
                className="shrink-0 rounded-full bg-white/20 px-2.5 py-0.5 text-xs font-medium transition-colors dark:bg-white/5"
              >
                <X className="mr-0.5 inline h-3 w-3" />
                {tagFilter}
              </button>
            )}
            {allTags.map(({ name, count }) => (
              <button
                key={name}
                onClick={() => setTagFilter(tagFilter === name ? null : name)}
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
                      onClick={() => handleSelect(msg)}
                    >
                      <div onClick={(e) => handleToggleStar(msg, e)} className="cursor-pointer">
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
                            <span
                              className={cn("truncate text-sm", !msg.isRead && "font-semibold")}
                            >
                              {getSender(msg)}
                            </span>
                            {!activeAccountId && msgAccount && (
                              <span className="text-muted-foreground shrink-0 text-[10px]">
                                {msgAccount.email}
                              </span>
                            )}
                          </div>
                          <span className="text-muted-foreground ml-2 shrink-0 text-xs">
                            {formatDistanceToNow(new Date(msg.date), {
                              addSuffix: false,
                            })}
                          </span>
                        </div>
                        <div className={cn("truncate text-sm", !msg.isRead && "font-medium")}>
                          {msg.subject || "(no subject)"}
                        </div>
                        <div className="text-muted-foreground truncate text-xs">
                          {msg.bodyPreview}
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
                <div ref={loadMoreRef} className="flex items-center justify-center py-4">
                  {loadingMore ? (
                    <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (!isAppending.current) {
                          isAppending.current = true;
                          loadMessagesRef.current(true).finally(() => {
                            isAppending.current = false;
                          });
                        }
                      }}
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

      {/* Message detail — desktop only */}
      <GlassPanel className="hidden flex-1 flex-col overflow-hidden border-0 md:flex">
        {selectedMessage ? (
          <>
            {/* Detail header with toolbar */}
            <div className="border-border/30 flex flex-col gap-3 border-b px-6 py-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-lg font-semibold">
                    {selectedMessage.subject || "(no subject)"}
                  </h2>
                  <div className="text-muted-foreground mt-1 flex items-center gap-2 text-sm">
                    <span className="truncate font-medium">{getSender(selectedMessage)}</span>
                    <span className="text-muted-foreground/60">
                      &lt;{selectedMessage.fromEmail}&gt;
                    </span>
                  </div>
                  <div className="text-muted-foreground mt-0.5 flex items-center gap-2 text-xs">
                    <span>To: {parseAddresses(selectedMessage.to).join(", ")}</span>
                  </div>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    {format(new Date(selectedMessage.date), "MMM d, yyyy 'at' h:mm a")}
                  </p>
                </div>
                <div className="shrink-0">
                  <MessageToolbar message={selectedMessage} onRefresh={refreshAll} />
                </div>
              </div>
            </div>

            {/* Message tags */}
            <div className="border-border/30 flex items-center gap-1.5 border-b px-6 py-2">
              {selectedMessage.tags.map((tag) => (
                <Badge
                  key={tag}
                  className={cn(
                    "cursor-pointer rounded-full px-2 py-0.5 text-xs",
                    getTagColor(tag),
                  )}
                  onClick={() => handleRemoveTag(selectedMessage.id, tag)}
                  title={`Remove "${tag}"`}
                >
                  {tag}
                  <X className="ml-0.5 h-2.5 w-2.5 opacity-50 hover:opacity-100" />
                </Badge>
              ))}
              <Popover open={addingTag} onOpenChange={setAddingTag}>
                <PopoverTrigger>
                  <span
                    className="inline-flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-white/10 dark:hover:bg-white/5"
                    title="Add tag"
                  >
                    <Plus className="h-3 w-3" />
                  </span>
                </PopoverTrigger>
                <PopoverContent className="w-56" align="start">
                  <div className="flex flex-col gap-2">
                    <p className="text-sm font-medium">Add tag</p>
                    <div className="flex gap-1.5">
                      <Input
                        autoFocus
                        value={newTagInput}
                        onChange={(e) => setNewTagInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            handleAddTag(selectedMessage.id, newTagInput);
                          }
                          if (e.key === "Escape") {
                            setAddingTag(false);
                            setNewTagInput("");
                          }
                        }}
                        placeholder="Tag name"
                        className="h-8"
                      />
                      <Button
                        size="sm"
                        className="h-8"
                        onClick={() => handleAddTag(selectedMessage.id, newTagInput)}
                      >
                        Add
                      </Button>
                    </div>
                    {allTags.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {allTags
                          .filter(({ name }) => !selectedMessage.tags.includes(name))
                          .slice(0, 6)
                          .map(({ name }) => (
                            <button
                              key={name}
                              onClick={() => handleAddTag(selectedMessage.id, name)}
                              className={cn(
                                "rounded-full px-2 py-0.5 text-xs transition-colors",
                                getTagColor(name),
                                "hover:opacity-80",
                              )}
                            >
                              + {name}
                            </button>
                          ))}
                      </div>
                    )}
                  </div>
                </PopoverContent>
              </Popover>
            </div>

            {/* Message body — use .email-content styles, not prose */}
            <GlassPanelContent className="flex-1 overflow-y-auto">
              {selectedMessage.bodyHtml ? (
                <div
                  className="max-w-none"
                  dangerouslySetInnerHTML={{ __html: selectedMessage.bodyHtml }}
                />
              ) : (
                <pre className="text-sm whitespace-pre-wrap">
                  {selectedMessage.bodyText || selectedMessage.bodyPreview}
                </pre>
              )}
            </GlassPanelContent>
          </>
        ) : (
          <GlassPanelContent className="flex flex-1 items-center justify-center">
            <div className="text-center">
              <Mail className="text-muted-foreground/30 mx-auto mb-3 h-12 w-12" />
              <p className="text-muted-foreground text-sm">Select an email to read</p>
            </div>
          </GlassPanelContent>
        )}
      </GlassPanel>

      {/* Message detail — mobile sheet */}
      <Sheet open={mobileDetailOpen} onOpenChange={setMobileDetailOpen}>
        <SheetContent className="flex w-full flex-col overflow-hidden p-0">
          <div className="flex h-full flex-col">
            {/* Header */}
            <SheetHeader className="border-border/30 flex items-center justify-between border-b px-4 pt-5 pb-3">
              <Button
                variant="ghost"
                size="icon"
                className="-ml-2 h-7 w-7"
                onClick={() => setMobileDetailOpen(false)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <SheetTitle className="truncate text-sm font-medium">
                {selectedMessage?.subject || "Email"}
              </SheetTitle>
              <div className="w-7" />
            </SheetHeader>

            {selectedMessage && (
              <>
                {/* Toolbar row — scrollable on small screens */}
                <div className="border-border/30 flex items-center gap-1 overflow-x-auto border-b px-4 py-2">
                  <MessageToolbar message={selectedMessage} onRefresh={refreshAll} />
                </div>

                <div className="flex-1 overflow-y-auto px-4">
                  {/* Sender info */}
                  <div className="py-3">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium">{getSender(selectedMessage)}</span>
                      <span className="text-muted-foreground text-xs">
                        &lt;{selectedMessage.fromEmail}&gt;
                      </span>
                    </div>
                    <div className="text-muted-foreground mt-0.5 text-xs">
                      To: {parseAddresses(selectedMessage.to).join(", ")}
                    </div>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {format(new Date(selectedMessage.date), "MMM d, yyyy 'at' h:mm a")}
                    </p>
                  </div>

                  {/* Tags */}
                  {selectedMessage.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 py-2">
                      {selectedMessage.tags.map((tag) => (
                        <Badge
                          key={tag}
                          className={cn(
                            "cursor-pointer rounded-full px-2 py-0.5 text-xs",
                            getTagColor(tag),
                          )}
                          onClick={() => handleRemoveTag(selectedMessage.id, tag)}
                        >
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  )}

                  {/* Message body — use .email-content styles, not prose */}
                  <div className="pb-4">
                    {selectedMessage.bodyHtml ? (
                      <div
                        className="max-w-none"
                        dangerouslySetInnerHTML={{ __html: selectedMessage.bodyHtml }}
                      />
                    ) : (
                      <pre className="text-sm whitespace-pre-wrap">
                        {selectedMessage.bodyText || selectedMessage.bodyPreview}
                      </pre>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
