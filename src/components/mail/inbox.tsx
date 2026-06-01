"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { getTagColor, collectTags } from "@/lib/email/tags";
import { Mail, Search, Star, RefreshCw, Loader2, Archive, Trash2, Plus, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatDistanceToNow, format } from "date-fns";

interface EmailMessage {
  id: string;
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

interface EmailAccount {
  id: string;
  email: string;
  enabled: boolean;
  lastSyncedAt: string | null;
  folders: string[];
  remoteFolders: string[];
  messageCount: number;
}

/** Parse the `to` field — stored as a JSON string in the DB */
function parseToField(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (typeof raw === "string" && raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter(Boolean);
      if (typeof parsed === "string") return [parsed];
    } catch {
      return [raw];
    }
  }
  return ["unknown"];
}

function getSender(msg: EmailMessage): string {
  if (msg.fromName) return msg.fromName;
  if (msg.fromEmail) return msg.fromEmail;
  return "Unknown Sender";
}

export function Inbox() {
  const searchParams = useSearchParams();
  const urlAccountId = searchParams.get("accountId");

  const [messages, setMessages] = useState<EmailMessage[]>([]);
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedMsg, setSelectedMsg] = useState<EmailMessage | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [_total, setTotal] = useState(0);
  const [togglingStar, setTogglingStar] = useState<string | null>(null);

  // Active account from URL param
  const activeAccountId = urlAccountId ?? null;

  const loadAccounts = useCallback(async () => {
    try {
      const res = await fetch("/api/email/accounts");
      if (res.ok) {
        const data = await res.json();
        setAccounts(data.accounts);
      }
    } catch {
      // Ignore
    }
  }, []);

  const loadMessages = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (activeAccountId) params.set("accountId", activeAccountId);
      if (folder) params.set("folder", folder);
      if (search) params.set("search", search);
      if (tagFilter) params.set("tag", tagFilter);

      const res = await fetch(`/api/email/messages?${params}`);
      if (res.ok) {
        const data = await res.json();
        setMessages(data.messages);
        setTotal(data.total);
      }
    } catch {
      // Ignore
    } finally {
      setLoading(false);
    }
  }, [activeAccountId, folder, search, tagFilter]);

  useEffect(() => {
    loadAccounts();
    loadMessages();
  }, [activeAccountId, folder, tagFilter, loadAccounts, loadMessages]);

  const handleSyncAll = async () => {
    setSyncing(true);
    try {
      const enabledAccounts = accounts.filter((a) => a.enabled);
      await Promise.all(
        enabledAccounts.map((acc) =>
          fetch(`/api/email/accounts/${acc.id}/sync`, { method: "POST" }),
        ),
      );
      await Promise.all([loadMessages(), loadAccounts()]);
    } catch {
      // Ignore
    } finally {
      setSyncing(false);
    }
  };

  const handleSelect = (msg: EmailMessage) => {
    setSelectedId(msg.id);
    setSelectedMsg(msg);
    if (!msg.isRead) {
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, isRead: true } : m)));
      // Also update selected message
      setSelectedMsg((prev) => (prev ? { ...prev, isRead: true } : prev));
    }
  };

  const handleSearch = useCallback(() => {
    loadMessages();
  }, [loadMessages]);

  const handleToggleStar = async (msg: EmailMessage, e: React.MouseEvent) => {
    e.stopPropagation();
    const newStarred = !msg.isStarred;
    const msgId = msg.id;
    setTogglingStar(msgId);

    // Optimistic update
    setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, isStarred: newStarred } : m)));
    if (selectedMsg?.id === msgId) {
      setSelectedMsg((prev) => (prev ? { ...prev, isStarred: newStarred } : prev));
    }

    try {
      const res = await fetch(`/api/email/messages/${msgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isStarred: newStarred }),
      });
      if (!res.ok) {
        // Revert on error
        setMessages((prev) =>
          prev.map((m) => (m.id === msgId ? { ...m, isStarred: !newStarred } : m)),
        );
        if (selectedMsg?.id === msgId) {
          setSelectedMsg((prev) => (prev ? { ...prev, isStarred: !newStarred } : prev));
        }
      }
    } catch {
      // Revert on error
      setMessages((prev) =>
        prev.map((m) => (m.id === msgId ? { ...m, isStarred: !newStarred } : m)),
      );
    } finally {
      setTogglingStar(null);
    }
  };

  const selectedMessage = selectedMsg;

  // Collect all unique tags with counts from loaded messages
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
      const res = await fetch(`/api/email/messages/${msgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: newTags }),
      });
      if (res.ok) {
        setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, tags: newTags } : m)));
        if (selectedMsg?.id === msgId) {
          setSelectedMsg((prev) => (prev ? { ...prev, tags: newTags } : prev));
        }
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
      const res = await fetch(`/api/email/messages/${msgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: newTags }),
      });
      if (res.ok) {
        setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, tags: newTags } : m)));
        if (selectedMsg?.id === msgId) {
          setSelectedMsg((prev) => (prev ? { ...prev, tags: newTags } : prev));
        }
      }
    } catch {
      // Ignore
    }
  };

  // Active account info
  const activeAccount = activeAccountId ? accounts.find((a) => a.id === activeAccountId) : null;

  // Derive folders
  const availableFolders = useMemo(() => {
    if (activeAccount) {
      const remote = activeAccount.remoteFolders.filter((f) => f.length > 0);
      if (remote.length > 0) {
        const inboxLike = remote.filter((f) => f.toUpperCase() === "INBOX");
        const rest = remote.filter((f) => f.toUpperCase() !== "INBOX").sort();
        return [...inboxLike, ...rest];
      }
      return activeAccount.folders.sort();
    }

    const folderSet = new Set<string>();
    for (const acc of accounts.filter((a) => a.enabled)) {
      for (const f of acc.folders) {
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

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-4">
      {/* Mail list */}
      <GlassPanel className="flex w-96 flex-col overflow-hidden">
        {/* Header */}
        <div className="border-border/50 flex items-center justify-between border-b px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">
              {activeAccount ? activeAccount.email : "All Mail"}
            </h2>
            {activeAccount && (
              <p className="text-muted-foreground text-[10px]">
                {activeAccount.messageCount} messages
                {activeAccount.lastSyncedAt
                  ? ` · ${new Date(activeAccount.lastSyncedAt).toLocaleDateString()}`
                  : ""}
              </p>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
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

        {/* Search */}
        <div className="border-border/30 border-b px-3 py-2">
          <div className="relative">
            <Search className="text-muted-foreground absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              placeholder="Search emails..."
              className="h-8 pl-8"
            />
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
                "shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                !folder
                  ? "bg-white/20 dark:bg-white/5"
                  : "text-muted-foreground hover:text-foreground",
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
                  "shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                  folder === f
                    ? "bg-white/20 dark:bg-white/5"
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
                className={cn(
                  "shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors",
                  "bg-white/20 dark:bg-white/5",
                )}
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
            <div className="flex items-center justify-center py-8">
              <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Mail className="text-muted-foreground/50 mb-2 h-8 w-8" />
              <p className="text-muted-foreground text-sm">
                {accounts.length === 0
                  ? "Connect an email account to get started"
                  : "No emails here"}
              </p>
            </div>
          ) : (
            messages.map((msg, i) => {
              const msgAccount = accounts.find((a) => a.id === msg.accountId);

              return (
                <div key={msg.id}>
                  <button
                    className={cn(
                      "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-white/20 dark:hover:bg-white/5",
                      selectedId === msg.id && "bg-white/20 dark:bg-white/5",
                      !msg.isRead && "font-medium",
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
                          <span className="truncate text-sm">{getSender(msg)}</span>
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
                      <div className="truncate text-sm">{msg.subject || "(no subject)"}</div>
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
            })
          )}
        </div>
      </GlassPanel>

      {/* Message detail */}
      <GlassPanel className="flex flex-1 flex-col overflow-hidden">
        {selectedMessage ? (
          <>
            {/* Detail header */}
            <div className="border-border/50 flex items-center justify-between border-b px-6 py-4">
              <div>
                <h2 className="text-lg font-semibold">
                  {selectedMessage.subject || "(no subject)"}
                </h2>
                <div className="text-muted-foreground mt-1 flex items-center gap-2 text-sm">
                  <span>{getSender(selectedMessage)}</span>
                  <span>→</span>
                  <span>{parseToField(selectedMessage.to).join(", ")}</span>
                </div>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {format(new Date(selectedMessage.date), "MMM d, yyyy 'at' h:mm a")}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <ReplyIcon className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <Archive className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <Trash2 className="h-4 w-4" />
                </Button>
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
                  <Button variant="ghost" size="icon" className="h-5 w-5" title="Add tag">
                    <Plus className="h-3 w-3" />
                  </Button>
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
                    {/* Suggest existing tags not yet on this message */}
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

            {/* Message body */}
            <GlassPanelContent className="flex-1 overflow-y-auto">
              {selectedMessage.bodyHtml ? (
                <div
                  className="prose prose-sm dark:prose-invert max-w-none"
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
    </div>
  );
}

function ReplyIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m9 17-5-5 5-5" />
      <path d="M20 18v-2a4 4 0 0 0-4-4H7" />
    </svg>
  );
}
