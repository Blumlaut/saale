"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn, ROW_ACTION } from "@/lib/utils";
import { fetchJson, deleteJson, postJson } from "@/lib/http";
import { useLongPress } from "@/hooks/use-long-press";
import { splitSessionsByActivity } from "@/lib/chat/session-recency";
import {
  Trash2,
  Loader2,
  Ghost,
  GitBranch,
  ChevronRight,
  MoreVertical,
  MessageSquarePlus,
  CheckSquare,
  X,
} from "lucide-react";

interface ChatSession {
  id: string;
  title: string;
  temporary: boolean;
  messageCount: number;
  updatedAt: string;
  lastActivityAt?: string;
  isGenerating?: boolean;
  forkedFromSessionId?: string;
}

/** Answer of the bulk delete endpoint — ids that went, ids that did not. */
interface BulkDeleteResponse {
  deleted: string[];
  failed: Array<{ sessionId: string; error: string }>;
}

/**
 * Broadcast that chats are gone. Both sidebars (the desktop panel and the
 * mobile sheet's) are mounted at once, so the other one has to prune the same
 * rows — and the ids travel with the event, so neither list needs a refetch.
 */
const SESSIONS_DELETED_EVENT = "chat-sessions-deleted";

function broadcastSessionsDeleted(ids: string[]) {
  window.dispatchEvent(new CustomEvent(SESSIONS_DELETED_EVENT, { detail: { ids } }));
}

const TITLE_MAX_CHARS = 25;

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

interface SessionRowProps {
  session: ChatSession;
  active: boolean;
  deleting: boolean;
  selecting: boolean;
  selected: boolean;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onToggleSelect: (id: string) => void;
  onSelectRow: (id: string) => void;
}

function SessionRow({
  session,
  active,
  deleting,
  selecting,
  selected,
  onOpen,
  onDelete,
  onToggleSelect,
  onSelectRow,
}: SessionRowProps) {
  // Holding a row is the touch way into a selection; ctrl/⌘-click is the pointer
  // way, and the row menu offers a labelled path for anyone who finds neither.
  const hold = useLongPress(() => {
    if (selecting) onToggleSelect(session.id);
    else onSelectRow(session.id);
  });

  const handleActivate = (event: ReactMouseEvent<HTMLButtonElement>) => {
    // The hold already acted on this gesture — the browser's click follows it.
    if (hold.consumeLongPress()) return;
    if (selecting || event.metaKey || event.ctrlKey) {
      event.preventDefault();
      onToggleSelect(session.id);
      return;
    }
    onOpen(session.id);
  };

  return (
    <div
      className={cn(
        "group relative flex items-center gap-1 rounded-lg py-2 pr-1 text-sm transition-colors duration-150",
        selecting ? "pl-1.5" : "pl-3",
        selected ? "bg-primary/10" : active ? "bg-accent/70" : "hover:bg-accent/60",
        selecting && "select-none",
      )}
      onPointerDown={hold.onPointerDown}
      onPointerMove={hold.onPointerMove}
      onPointerUp={hold.onPointerUp}
      onPointerCancel={hold.onPointerCancel}
      onContextMenu={hold.onContextMenu}
    >
      {selecting && (
        <Checkbox
          checked={selected}
          onCheckedChange={() => onToggleSelect(session.id)}
          aria-label={`Select ${session.title}`}
          className="ml-1.5"
        />
      )}
      <button
        className="flex min-w-0 flex-1 flex-col items-start text-left"
        onClick={handleActivate}
      >
        <div className="flex items-center gap-1.5">
          <div className="truncate font-medium">
            {session.title.length > TITLE_MAX_CHARS
              ? `${session.title.slice(0, TITLE_MAX_CHARS)}…`
              : session.title}
          </div>
          {session.isGenerating && (
            <span className="text-muted-foreground animate-pulse-dot -ml-0.5 h-1 w-1 shrink-0 rounded-full bg-current" />
          )}
          {session.forkedFromSessionId && (
            <GitBranch className="text-muted-foreground h-3 w-3 shrink-0" />
          )}
          {session.temporary && <Ghost className="text-muted-foreground h-3 w-3 shrink-0" />}
        </div>
        <div className="text-muted-foreground truncate text-xs">
          {formatDate(session.lastActivityAt ?? session.updatedAt)} · {session.messageCount}{" "}
          messages
          {session.forkedFromSessionId && " · fork"}
          {session.temporary && " · auto-delete"}
        </div>
      </button>
      {/* Delete lives behind the row menu: a permanent one-tap delete next to
          every row is too easy to hit while scrolling. */}
      {!selecting && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={(triggerProps) => (
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn("shrink-0", ROW_ACTION)}
                {...triggerProps}
              >
                {deleting ? <Loader2 className="animate-spin" /> : <MoreVertical />}
                <span className="sr-only">Actions for {session.title}</span>
              </Button>
            )}
          />
          <DropdownMenuContent align="end" className="min-w-40">
            <DropdownMenuItem onClick={() => onSelectRow(session.id)}>
              <CheckSquare />
              Select chat
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              disabled={deleting}
              onClick={() => onDelete(session.id)}
            >
              <Trash2 />
              Delete chat
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

export function SessionSidebar({
  activeSessionId,
  onNewChat,
}: {
  activeSessionId?: string;
  onNewChat?: () => void;
}) {
  const router = useRouter();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [olderOpen, setOlderOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  // No separate mode flag: a selection exists exactly as long as chats are
  // picked, so dropping the last one leaves the list back in its normal state.
  const selecting = selectedIds.size > 0;

  const fetchSessions = useCallback(async () => {
    try {
      const data = await fetchJson<{ sessions: ChatSession[] }>("/api/chat/sessions");
      setSessions(data.sessions);
    } catch (err) {
      console.error("Failed to load chat sessions:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions, activeSessionId]); // refetch when active session changes

  // Renames happen elsewhere in the tree, deletions in whichever list was
  // used — both events keep this list in step with the server.
  useEffect(() => {
    const onRenamed = () => fetchSessions();
    const onDeleted = (event: Event) => {
      const ids = (event as CustomEvent<{ ids?: string[] }>).detail?.ids;
      if (!ids || ids.length === 0) return;
      const gone = new Set(ids);
      setSessions((prev) => prev.filter((session) => !gone.has(session.id)));
    };

    window.addEventListener("chat-renamed", onRenamed);
    window.addEventListener(SESSIONS_DELETED_EVENT, onDeleted);
    return () => {
      window.removeEventListener("chat-renamed", onRenamed);
      window.removeEventListener(SESSIONS_DELETED_EVENT, onDeleted);
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

  const deleteSession = async (id: string) => {
    setDeletingId(id);
    try {
      await deleteJson(`/api/chat/sessions/${id}`);
      broadcastSessionsDeleted([id]);
      if (activeSessionId === id) {
        router.push("/dashboard/chat");
      }
    } catch (err) {
      console.error("Failed to delete chat session:", err);
    }
    setDeletingId(null);
  };

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

  const deleteSelected = async () => {
    const ids = [...selectedIds];
    setBulkDeleting(true);
    try {
      const result = await postJson<BulkDeleteResponse>("/api/chat/sessions/bulk", { ids });
      const deleted = new Set(result.deleted);
      broadcastSessionsDeleted(result.deleted);
      // Whatever survived stays picked, so a retry is one tap away.
      setSelectedIds(new Set(result.failed.map((failure) => failure.sessionId)));
      if (activeSessionId && deleted.has(activeSessionId)) {
        router.push("/dashboard/chat");
      }
      if (result.failed.length > 0) {
        toast.error(
          `Could not delete ${result.failed.length} of ${ids.length} chats — they are still selected`,
        );
      }
    } catch (err) {
      console.error("Failed to delete chat sessions:", err);
      toast.error("Could not delete the selected chats");
    }
    setBulkDeleting(false);
  };

  const { recent, older } = useMemo(() => splitSessionsByActivity(sessions), [sessions]);

  const activeIsOlder = older.some((s) => s.id === activeSessionId);
  // The active chat must never hide inside the fold, and an all-old list would
  // otherwise look empty on arrival.
  const olderAutoOpen = activeIsOlder || (older.length > 0 && recent.length === 0);

  // Navigation re-applies the auto state so a manual collapse never hides the
  // chat you just opened.
  useEffect(() => {
    setOlderOpen(olderAutoOpen);
  }, [activeSessionId, olderAutoOpen]);

  const openSession = useCallback((id: string) => router.push(`/dashboard/chat/${id}`), [router]);

  const renderRow = (session: ChatSession) => (
    <SessionRow
      key={session.id}
      session={session}
      active={session.id === activeSessionId}
      deleting={deletingId === session.id}
      selecting={selecting}
      selected={selectedIds.has(session.id)}
      onOpen={openSession}
      onDelete={deleteSession}
      onToggleSelect={toggleSelect}
      onSelectRow={selectRow}
    />
  );

  const selectedCount = selectedIds.size;

  return (
    <GlassPanel className="flex h-full flex-col overflow-hidden rounded-none border-0 md:rounded-2xl">
      {/* Header */}
      <div className="border-border/30 flex h-11 shrink-0 items-center border-b px-4">
        <h2 className="text-sm font-semibold">Conversations</h2>
      </div>

      {/* New chat — mobile sheet only (the desktop header owns its own action) */}
      {onNewChat && (
        <div className="border-border/30 border-b p-2">
          <Button
            className="liquid-glass-accent h-9 w-full justify-center gap-2 rounded-lg"
            onClick={onNewChat}
          >
            <MessageSquarePlus className="h-4 w-4" />
            New Chat
          </Button>
        </div>
      )}

      {/* Selection bar — directly above the list it acts on, and below the top
          row: the mobile sheet draws its own close button in the panel's corner. */}
      {selecting && (
        <div className="border-border/30 flex h-11 shrink-0 items-center gap-1 border-b px-2 md:px-4">
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
            disabled={bulkDeleting}
            onClick={() => setConfirmOpen(true)}
          >
            {bulkDeleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
            Delete
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
                  <Badge variant="secondary" className="font-mono">
                    {older.length}
                  </Badge>
                </CollapsibleTrigger>
                <CollapsibleContent>{older.map(renderRow)}</CollapsibleContent>
              </Collapsible>
            )}
          </div>
        )}
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selectedCount} {selectedCount === 1 ? "chat" : "chats"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes {selectedCount === 1 ? "the chat" : "the chats"}, along with{" "}
              {selectedCount === 1 ? "its" : "their"} messages and attachments. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={deleteSelected}>
              <Trash2 />
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </GlassPanel>
  );
}
