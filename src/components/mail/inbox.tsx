"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { collectTags } from "@/lib/email/tags";
import { fetchJson, patchJson } from "@/lib/http";
import { EmailListPanel } from "./email-list-panel";
import { EmailDetailPanel } from "./email-detail-panel";
import { EmailDetailSheet } from "./email-detail-sheet";
import type { EmailMessage, EmailMessageDetail, InboxEmailAccount } from "./types";

export function Inbox() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const urlAccountId = searchParams.get("accountId");
  const urlMsgId = searchParams.get("msg");

  const [messages, setMessages] = useState<EmailMessage[]>([]);
  const [accounts, setAccounts] = useState<InboxEmailAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedMsg, setSelectedMsg] = useState<EmailMessageDetail | null>(null);
  const [loadingMessage, setLoadingMessage] = useState(false);
  const [folder, setFolder] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [togglingStar, setTogglingStar] = useState<string | null>(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [addingTag, setAddingTag] = useState(false);
  const [newTagInput, setNewTagInput] = useState("");

  const loadMoreRef = useRef<HTMLDivElement>(null);
  const lastAutoSelectedMsg = useRef<string | null>(null);
  const loadMessagesRef = useRef<((append?: boolean) => Promise<void>) | null>(null);
  const isAppending = useRef(false);

  const activeAccountId = urlAccountId ?? null;
  const LIMIT = 25;

  // ─── Data loading ────────────────────────────────────────────────────────

  const loadAccounts = useCallback(async () => {
    try {
      const data = await fetchJson<{ accounts: InboxEmailAccount[] }>(
        "/api/email/accounts?includeFolders=true",
      );
      setAccounts(data.accounts);
    } catch (err) {
      console.error("Failed to load email accounts:", err);
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
        const params = new URLSearchParams({
          limit: String(LIMIT),
          offset: String(append ? offset : 0),
        });
        if (activeAccountId) params.set("accountId", activeAccountId);
        if (folder) params.set("folder", folder);
        if (debouncedSearch) params.set("q", debouncedSearch);
        if (tagFilter) params.set("tag", tagFilter);

        const data = await fetchJson<{
          messages: EmailMessage[];
          hasMore: boolean;
        }>(`/api/email/messages?${params}`);

        setMessages(append ? (prev) => [...prev, ...data.messages] : data.messages);
        setHasMore(data.hasMore);
        if (append) setOffset((prev) => prev + data.messages.length);
      } catch (err) {
        console.error("Failed to load messages:", err);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [activeAccountId, folder, debouncedSearch, tagFilter, offset],
  );

  // Keep a ref for scroll-triggered loads (avoids stale closure)
  useEffect(() => {
    loadMessagesRef.current = loadMessages;
  }, [loadMessages]);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadAccounts(), loadMessages()]);
  }, [loadAccounts, loadMessages]);

  const handleSyncAll = async () => {
    setSyncing(true);
    try {
      await fetchJson("/api/email/sync", { method: "POST" });
      toast.success("Sync started");
      await loadAccounts();
    } catch (err) {
      console.error("Failed to sync accounts:", err);
      toast.error("Failed to sync");
    } finally {
      setSyncing(false);
    }
  };

  // ─── Message detail ──────────────────────────────────────────────────────

  const fetchMessageDetail = useCallback(
    async (msg: EmailMessage): Promise<EmailMessageDetail | null> => {
      try {
        const data = await fetchJson<{ message: EmailMessageDetail }>(
          `/api/email/messages/${msg.id}`,
        );
        return data.message;
      } catch (err) {
        console.error("Failed to load message detail:", err);
        return null;
      }
    },
    [],
  );

  const loadAndSelectMessage = useCallback(
    async (msg: EmailMessage) => {
      setSelectedId(msg.id);
      setLoadingMessage(true);
      const detail = await fetchMessageDetail(msg);
      if (detail) {
        setSelectedMsg(detail);
      }
      setLoadingMessage(false);
    },
    [fetchMessageDetail],
  );

  // ─── URL params ──────────────────────────────────────────────────────────

  const updateUrlParams = useCallback(
    (msgId: string | null) => {
      const params = new URLSearchParams();
      if (activeAccountId) params.set("accountId", activeAccountId);
      if (msgId) params.set("msg", msgId);
      router.replace(`/dashboard/mail?${params.toString()}`);
    },
    [activeAccountId, router],
  );

  // ─── Message handlers ────────────────────────────────────────────────────

  const handleSelect = async (msg: EmailMessage) => {
    setSelectedId(msg.id);
    updateUrlParams(msg.id);

    // Mark as read (fire-and-forget)
    if (!msg.isRead) {
      patchJson(`/api/email/messages/${msg.id}`, { isRead: true }).catch((err) => {
        console.error("Failed to mark as read:", err);
      });
    }

    if (msg.bodyHtml || msg.bodyText) {
      setSelectedMsg(msg as EmailMessageDetail);
    } else {
      await loadAndSelectMessage(msg);
    }

    if (window.innerWidth < 768) {
      setMobileDetailOpen(true);
    }
  };

  const handleToggleStar = async (msg: EmailMessage, e: React.MouseEvent) => {
    e.stopPropagation();
    setTogglingStar(msg.id);
    try {
      await patchJson(`/api/email/messages/${msg.id}`, {
        isStarred: !msg.isStarred,
      });
    } catch (err) {
      console.error("Failed to toggle star:", err);
    } finally {
      setTogglingStar(null);
    }
  };

  const handleMarkAllRead = async () => {
    try {
      const params = new URLSearchParams();
      if (activeAccountId) params.set("accountId", activeAccountId);
      if (folder) params.set("folder", folder);
      await patchJson(`/api/email/messages/mark-all-read?${params}`, {});
      await loadMessages();
    } catch (err) {
      console.error("Failed to mark all as read:", err);
    }
  };

  // ─── Tag handlers ────────────────────────────────────────────────────────

  const handleAddTag = async (msgId: string, tag: string) => {
    const trimmed = tag
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, "");
    if (!trimmed) return;
    try {
      await patchJson(`/api/email/messages/${msgId}/tags`, { tag: trimmed });
      setAddingTag(false);
      setNewTagInput("");
      await loadMessages();
    } catch (err) {
      console.error("Failed to add tag:", err);
      toast.error("Failed to add tag");
    }
  };

  const handleRemoveTag = async (msgId: string, tag: string) => {
    try {
      await patchJson(`/api/email/messages/${msgId}/tags`, { tag, remove: true });
      await loadMessages();
    } catch (err) {
      console.error("Failed to remove tag:", err);
    }
  };

  // ─── Computed ────────────────────────────────────────────────────────────

  const allTags = useMemo(() => collectTags(messages), [messages]);
  const unreadCount = useMemo(() => messages.filter((m) => !m.isRead).length, [messages]);

  const activeAccount = activeAccountId ? accounts.find((a) => a.id === activeAccountId) : null;
  const availableFolders = useMemo(() => {
    if (!activeAccount || !activeAccount.remoteFolders) return [];

    const folders = [...activeAccount.remoteFolders];
    const inboxIdx = folders.findIndex((f) => f === "INBOX");
    if (inboxIdx > 0) {
      folders.splice(inboxIdx, 1);
      folders.unshift("INBOX");
    }
    return folders;
  }, [activeAccount]);

  // ─── Effects ─────────────────────────────────────────────────────────────

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Reload when filters change
  useEffect(() => {
    setOffset(0);
    setHasMore(false);
    loadMessages();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAccountId, folder, tagFilter]);

  // Initial load
  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  // Auto-select from URL
  useEffect(() => {
    if (!urlMsgId) return;
    const msg = messages.find((m) => m.id === urlMsgId);
    if (msg && msg.id !== lastAutoSelectedMsg.current) {
      lastAutoSelectedMsg.current = msg.id;
      void handleSelect(msg);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlMsgId, messages]);

  // Intersection observer for infinite scroll
  useEffect(() => {
    const el = loadMoreRef.current;
    if (!el || !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isAppending.current) {
          isAppending.current = true;
          loadMessagesRef.current?.(true).finally(() => {
            isAppending.current = false;
          });
        }
      },
      { rootMargin: "200px" },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore]);

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-4 md:h-[calc(100vh-7rem)]">
      <EmailListPanel
        messages={messages}
        accounts={accounts}
        activeAccountId={activeAccountId}
        folders={availableFolders}
        folder={folder}
        tagFilter={tagFilter}
        search={search}
        debouncedSearch={debouncedSearch}
        loading={loading}
        loadingMore={loadingMore}
        hasMore={hasMore}
        selectedId={selectedId}
        togglingStar={togglingStar}
        unreadCount={unreadCount}
        syncing={syncing}
        onSearchChange={setSearch}
        onFolderChange={(f) => {
          setFolder(f);
          setSelectedId(null);
          setSelectedMsg(null);
          lastAutoSelectedMsg.current = null;
          updateUrlParams(null);
        }}
        onTagFilterChange={(t) => {
          setTagFilter(t);
          setSelectedId(null);
          setSelectedMsg(null);
          lastAutoSelectedMsg.current = null;
          updateUrlParams(null);
        }}
        onSelectMessage={handleSelect}
        onToggleStar={handleToggleStar}
        onLoadMore={() => {
          if (!isAppending.current) {
            isAppending.current = true;
            loadMessagesRef.current?.(true).finally(() => {
              isAppending.current = false;
            });
          }
        }}
        onSyncAll={handleSyncAll}
        onMarkAllRead={handleMarkAllRead}
      />

      <EmailDetailPanel
        message={selectedMsg}
        loadingMessage={loadingMessage}
        allTags={allTags}
        addingTag={addingTag}
        newTagInput={newTagInput}
        onToggleAddingTag={setAddingTag}
        onNewTagInputChange={setNewTagInput}
        onAddTag={handleAddTag}
        onRemoveTag={handleRemoveTag}
        onRefresh={refreshAll}
      />

      <EmailDetailSheet
        open={mobileDetailOpen}
        onClose={() => setMobileDetailOpen(false)}
        message={selectedMsg}
        loadingMessage={loadingMessage}
        onRemoveTag={handleRemoveTag}
        onRefresh={refreshAll}
      />
    </div>
  );
}
