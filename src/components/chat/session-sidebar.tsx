"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { PinnedChatGroup, ChatListRow, WatcherChatBadge } from "@/components/chat/chat-list";
import { useOnResume } from "@/hooks/use-on-resume";
import { fetchJson, postJson } from "@/lib/http";
import {
  broadcastSessionsDeleted,
  CHAT_PINNED_EVENT,
  CHAT_RENAMED_EVENT,
  CHAT_SESSIONS_DELETED_EVENT,
  CHAT_WATCHERS_EVENT,
} from "@/lib/chat/session-events";
import { saveChatPin } from "@/lib/chat/pin";
import { forcedRetryError, isForcedRetry } from "@/lib/coder/force-delete";
import { ForceDeleteDialog } from "@/components/shared/force-delete-dialog";
import { splitPinnedSessions, splitSessionsByActivity } from "@/lib/chat/session-recency";
import {
  Trash2,
  Loader2,
  Ghost,
  GitBranch,
  ChevronLeft,
  ChevronRight,
  MessageSquarePlus,
  Radar,
  X,
} from "lucide-react";

interface ChatSession {
  id: string;
  title: string;
  temporary: boolean;
  pinned: boolean;
  messageCount: number;
  watcherCount: number;
  updatedAt: string;
  lastActivityAt?: string;
  isGenerating?: boolean;
  forkedFromSessionId?: string;
  /** "watcher" for a chat a watcher fire opened. */
  origin?: string;
  /** The checkout a coder chat runs in. */
  worktree?: { branch: string } | null;
}

/** The project a coder chat list belongs to, as its header names it. */
interface CoderProjectHeader {
  id: string;
  name: string;
  slug: string;
  defaultBranch: string;
}

/** Answer of the bulk delete endpoint. ids that went, ids that did not. */
interface BulkDeleteResponse {
  deleted: string[];
  failed: Array<{ sessionId: string; error: string; code?: string }>;
}

function watcherLabel(count: number): string {
  return `${count} ${count === 1 ? "watcher" : "watchers"} attached`;
}

function formatDate(dateStr: string) {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString();
}

/**
 * One user's chat list, in the chat view and in a coder project.
 *
 * The two lists read the same endpoint (a project's chats are the same rows,
 * with a `projectId`), so a row opens, pins, picks and deletes the same way in
 * both. A project list adds the project's name and each chat's branch, which is
 * what tells two chats of one project apart.
 */
export function SessionSidebar({
  activeSessionId,
  onNewChat,
  projectId,
}: {
  activeSessionId?: string;
  onNewChat?: () => void;
  /** Set for a coder project's chats. */
  projectId?: string;
}) {
  const router = useRouter();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [project, setProject] = useState<CoderProjectHeader | null>(null);
  const [loading, setLoading] = useState(true);
  const [olderOpen, setOlderOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  // The pending delete's ids. one from the row menu, several from the
  // selection bar. so both paths run through the same confirmation.
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null);
  const [deletingIds, setDeletingIds] = useState<string[]>([]);

  const listUrl = projectId
    ? `/api/chat/sessions?projectId=${encodeURIComponent(projectId)}`
    : "/api/chat/sessions";

  // No separate mode flag: a selection exists exactly as long as chats are
  // picked, so dropping the last one leaves the list back in its normal state.
  const selecting = selectedIds.size > 0;

  const fetchSessions = useCallback(async () => {
    try {
      const data = await fetchJson<{
        sessions: ChatSession[];
        project?: CoderProjectHeader | null;
      }>(listUrl);
      setSessions(data.sessions);
      setProject(data.project ?? null);
    } catch (err) {
      console.error("Failed to load chat sessions:", err);
    } finally {
      setLoading(false);
    }
  }, [listUrl]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions, activeSessionId]); // refetch when active session changes

  // A suspended app comes back to whatever the list looked like when it was
  // last on screen. anything said or finished elsewhere is new.
  useOnResume(() => {
    void fetchSessions();
  });

  // Renames happen elsewhere in the tree, deletions in whichever list was
  // used. both events keep this list in step with the server.
  useEffect(() => {
    const onRenamed = () => fetchSessions();
    // A watcher bound to a chat rides along with it on delete, so the mark has
    // to appear and vanish as watchers come and go elsewhere in the app.
    const onWatchers = () => fetchSessions();
    const onDeleted = (event: Event) => {
      const ids = (event as CustomEvent<{ ids?: string[] }>).detail?.ids;
      if (!ids || ids.length === 0) return;
      const gone = new Set(ids);
      setSessions((prev) => prev.filter((session) => !gone.has(session.id)));
    };
    // A pin made in the other copy of this list (phone sheet, desktop panel)
    // moves the row here too.
    const onPinned = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string; pinned?: boolean }>).detail;
      if (!detail?.id || typeof detail.pinned !== "boolean") return;
      const { id, pinned } = detail;
      setSessions((prev) =>
        prev.map((session) => (session.id === id ? { ...session, pinned } : session)),
      );
    };

    window.addEventListener(CHAT_RENAMED_EVENT, onRenamed);
    window.addEventListener(CHAT_SESSIONS_DELETED_EVENT, onDeleted);
    window.addEventListener(CHAT_PINNED_EVENT, onPinned);
    window.addEventListener(CHAT_WATCHERS_EVENT, onWatchers);
    return () => {
      window.removeEventListener(CHAT_RENAMED_EVENT, onRenamed);
      window.removeEventListener(CHAT_SESSIONS_DELETED_EVENT, onDeleted);
      window.removeEventListener(CHAT_PINNED_EVENT, onPinned);
      window.removeEventListener(CHAT_WATCHERS_EVENT, onWatchers);
    };
  }, [fetchSessions]);

  // Escape is the keyboard way out, next to the selection bar's ✕.
  useEffect(() => {
    if (!selecting) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedIds(new Set());
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selecting]);

  // One delete for one or many: the bulk endpoint takes both, and a failed
  // single delete reports like a failed batch.
  const deleteChats = async (ids: string[], force: boolean) => {
    setDeletingIds(ids);
    let result: BulkDeleteResponse;
    try {
      result = await postJson<BulkDeleteResponse>(
        "/api/chat/sessions/bulk",
        force ? { ids, force: true } : { ids },
      );
    } catch (err) {
      console.error("Failed to delete chat sessions:", err);
      throw err;
    } finally {
      setDeletingIds([]);
    }

    const deleted = new Set(result.deleted);
    broadcastSessionsDeleted(result.deleted);
    const survivors = result.failed.map((failure) => failure.sessionId);
    // Whatever survived stays picked, and stays in the box, so the retry that
    // confirms the discard targets only the chats still there.
    setSelectedIds(new Set(survivors));
    setPendingDelete(survivors.length > 0 ? survivors : null);
    if (activeSessionId && deleted.has(activeSessionId)) {
      router.push(projectId ? `/dashboard/coder/${projectId}` : "/dashboard/chat");
    }
    if (result.failed.length === 0) return;

    const reason = result.failed[0]?.error ?? "Could not delete the chat";
    if (deleted.size > 0) {
      toast.error(
        `Deleted ${deleted.size} of ${ids.length} chats. the rest are still selected: ${reason}`,
      );
    }
    // The box shows the reason, and asks again when a confirmation overrides it.
    throw result.failed.every((failure) => isForcedRetry(failure.code))
      ? forcedRetryError(reason)
      : new Error(reason);
  };

  const requestDelete = (ids: string[]) => setPendingDelete(ids);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectRow = useCallback((id: string) => {
    setSelectedIds((prev) => new Set(prev).add(id));
  }, []);

  // The row moves the moment the pin is clicked. a failed request puts it back,
  // so the list never claims a pin the server did not keep.
  const togglePin = useCallback(async (id: string, pinned: boolean) => {
    const apply = (value: boolean) =>
      setSessions((prev) =>
        prev.map((session) => (session.id === id ? { ...session, pinned: value } : session)),
      );

    apply(pinned);
    try {
      await saveChatPin(id, pinned);
    } catch (err) {
      console.error(`Failed to ${pinned ? "pin" : "unpin"} chat ${id}:`, err);
      apply(!pinned);
      toast.error(pinned ? "Could not pin the chat" : "Could not unpin the chat");
    }
  }, []);

  const { pinned: pinnedSessions, unpinned } = useMemo(
    () => splitPinnedSessions(sessions),
    [sessions],
  );
  const { recent, older } = useMemo(() => splitSessionsByActivity(unpinned), [unpinned]);

  const activeIsOlder = older.some((s) => s.id === activeSessionId);
  // The active chat must never hide inside the fold, and an all-old list would
  // otherwise look empty on arrival.
  const olderAutoOpen = activeIsOlder || (older.length > 0 && recent.length === 0);

  // Navigation re-applies the auto state so a manual collapse never hides the
  // chat you just opened.
  useEffect(() => {
    setOlderOpen(olderAutoOpen);
  }, [activeSessionId, olderAutoOpen]);

  const sessionHref = useCallback(
    (id: string) => (projectId ? `/dashboard/coder/${projectId}/${id}` : `/dashboard/chat/${id}`),
    [projectId],
  );

  const renderRow = (session: ChatSession) => (
    <ChatListRow
      key={session.id}
      title={session.title}
      active={session.id === activeSessionId}
      pinned={session.pinned}
      deleting={deletingIds.includes(session.id)}
      accessories={
        <>
          {session.isGenerating && (
            <span className="text-muted-foreground animate-pulse-dot -ml-0.5 h-1 w-1 shrink-0 rounded-full bg-current" />
          )}
          {session.forkedFromSessionId && (
            <GitBranch className="text-muted-foreground h-3 w-3 shrink-0" />
          )}
          {session.temporary && <Ghost className="text-muted-foreground h-3 w-3 shrink-0" />}
          {session.origin === "watcher" && <WatcherChatBadge />}
          {session.watcherCount > 0 && (
            // Watchers go when the chat goes, and are otherwise only visible
            // inside the conversation, so the list has to own up to them.
            <span
              role="img"
              title={watcherLabel(session.watcherCount)}
              aria-label={watcherLabel(session.watcherCount)}
              className="text-muted-foreground flex shrink-0 items-center"
            >
              <Radar className="h-3.5 w-3.5" />
            </span>
          )}
        </>
      }
      subtitle={
        <>
          <span className="shrink-0">
            {formatDate(session.lastActivityAt ?? session.updatedAt)}
          </span>
          {/* A branch tells two chats of one project apart, so it takes the room
              the message count gets in the chat view. */}
          {session.worktree ? (
            <span className="min-w-0 truncate">{session.worktree.branch}</span>
          ) : (
            <span className="shrink-0">{session.messageCount} messages</span>
          )}
          {session.forkedFromSessionId && <span className="shrink-0">fork</span>}
          {session.temporary && <span className="shrink-0">auto-delete</span>}
        </>
      }
      selection={{
        selecting,
        selected: selectedIds.has(session.id),
        toggle: () => toggleSelect(session.id),
        start: () => selectRow(session.id),
      }}
      href={sessionHref(session.id)}
      onTogglePin={() => togglePin(session.id, !session.pinned)}
      onDelete={() => requestDelete([session.id])}
    />
  );

  const selectedCount = selectedIds.size;

  const pendingCount = pendingDelete?.length ?? 0;
  const pendingWatcherCount = (pendingDelete ?? []).reduce(
    (count, id) => count + (sessions.find((s) => s.id === id)?.watcherCount ?? 0),
    0,
  );
  // A project change keeps the last header until the new list answers.
  const header = project?.id === projectId ? project : null;

  return (
    <GlassPanel className="flex h-full flex-col overflow-hidden rounded-none border-0 md:rounded-2xl">
      {/* Header. a project's chat list names the project and leads back to the
          rest of them. */}
      {projectId ? (
        <div className="border-border/30 flex shrink-0 items-center gap-1 border-b px-2 py-2">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="All projects"
            onClick={() => router.push("/dashboard/coder")}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{header?.name ?? "Project"}</p>
            <p className="text-muted-foreground truncate text-xs">
              {header ? `${header.slug} · ${header.defaultBranch}` : ""}
            </p>
          </div>
        </div>
      ) : (
        <div className="border-border/30 flex h-11 shrink-0 items-center border-b px-4">
          <h2 className="text-sm font-semibold">Conversations</h2>
        </div>
      )}

      {/* New chat. the desktop views own their own action. */}
      {onNewChat && (
        <div className="border-border/30 border-b p-2">
          <Button className="h-9 w-full justify-center gap-2 rounded-lg" onClick={onNewChat}>
            <MessageSquarePlus className="h-4 w-4" />
            New chat
          </Button>
        </div>
      )}

      {/* Session list */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
          </div>
        ) : sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <p className="text-muted-foreground text-sm">No conversations yet</p>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
            <PinnedChatGroup
              pinned={pinnedSessions}
              renderRows={(items) => items.map(renderRow)}
              hasRest={recent.length > 0 || older.length > 0}
            >
              {recent.map(renderRow)}

              {older.length > 0 && (
                <Collapsible
                  open={olderOpen}
                  onOpenChange={setOlderOpen}
                  className="border-border/40 mt-1 border-t pt-1"
                >
                  <CollapsibleTrigger
                    aria-label={olderOpen ? "Hide older chats" : "Show older chats"}
                    className="group text-muted-foreground hover:bg-accent/60 hover:text-foreground flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs transition-colors duration-150"
                  >
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform duration-150 group-data-panel-open:rotate-90" />
                    <span className="min-w-0 flex-1 truncate font-medium">Older chats</span>
                    <Badge variant="secondary" className="tabular-nums">
                      {older.length}
                    </Badge>
                  </CollapsibleTrigger>
                  <CollapsibleContent>{older.map(renderRow)}</CollapsibleContent>
                </Collapsible>
              )}
            </PinnedChatGroup>
          </div>
        )}
      </div>

      {/* Selection bar. pinned below the list, not above it: a row that jumps
          out from under the finger would hand the click that follows a hold to
          a neighbour, and select a chat nobody touched. Out of reach of the
          sheet's own close button in the panel's top corner, too. */}
      {selecting && (
        <div className="border-border/30 flex h-11 shrink-0 items-center gap-1 border-t px-2 md:px-4">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Cancel selection"
            onClick={() => setSelectedIds(new Set())}
          >
            <X />
          </Button>
          <span className="min-w-0 flex-1 truncate px-1 text-sm font-medium">
            {selectedCount} selected
          </span>
          <Button
            variant="destructive"
            size="sm"
            className="h-8 shrink-0"
            aria-label={`Delete ${selectedCount} selected ${selectedCount === 1 ? "chat" : "chats"}`}
            disabled={deletingIds.length > 0}
            onClick={() => requestDelete([...selectedIds])}
          >
            {deletingIds.length > 0 ? <Loader2 className="animate-spin" /> : <Trash2 />}
            Delete
          </Button>
        </div>
      )}

      {/* One confirmation for both delete paths. Watchers ride along with the
          chat (the DB cascade removes them), so the box says so when any are
          attached. otherwise the user loses scheduled jobs without a trace. */}
      <ForceDeleteDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={`Delete ${pendingCount} ${pendingCount === 1 ? "chat" : "chats"}?`}
        description={
          <>
            This removes {pendingCount === 1 ? "the chat" : "the chats"}, along with{" "}
            {pendingCount === 1 ? "its" : "their"} messages and attachments.
            {pendingWatcherCount > 0 && (
              <>
                {" "}
                This also deletes {pendingWatcherCount}{" "}
                {pendingWatcherCount === 1 ? "watcher" : "watchers"}. their scheduled checks stop
                immediately.
              </>
            )}{" "}
            This cannot be undone.
          </>
        }
        discard={
          pendingCount === 1
            ? "this chat's uncommitted changes"
            : "these chats' uncommitted changes"
        }
        onDelete={(force) =>
          pendingDelete ? deleteChats(pendingDelete, force) : Promise.resolve()
        }
      />
    </GlassPanel>
  );
}
