"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { fetchJson, deleteJson } from "@/lib/http";
import { splitSessionsByActivity } from "@/lib/chat/session-recency";
import { Trash2, Loader2, Ghost, GitBranch, ChevronRight } from "lucide-react";

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
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}

function SessionRow({ session, active, deleting, onOpen, onDelete }: SessionRowProps) {
  return (
    <div
      className={cn(
        "group relative flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors duration-150",
        active ? "bg-accent/70" : "hover:bg-accent/60",
      )}
    >
      <button
        className="flex min-w-0 flex-1 flex-col items-start text-left"
        onClick={() => onOpen(session.id)}
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
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0 opacity-0 group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(session.id);
        }}
        disabled={deleting}
      >
        {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
        <span className="sr-only">Delete {session.title}</span>
      </Button>
    </div>
  );
}

export function SessionSidebar({ activeSessionId }: { activeSessionId?: string }) {
  const router = useRouter();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [olderOpen, setOlderOpen] = useState(false);

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

  // Refetch when a chat is renamed
  useEffect(() => {
    const handler = () => fetchSessions();
    window.addEventListener("chat-renamed", handler);
    return () => window.removeEventListener("chat-renamed", handler);
  }, [fetchSessions]);

  const deleteSession = async (id: string) => {
    setDeletingId(id);
    try {
      await deleteJson(`/api/chat/sessions/${id}`);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (activeSessionId === id) {
        router.push("/dashboard/chat");
      }
    } catch (err) {
      console.error("Failed to delete chat session:", err);
    }
    setDeletingId(null);
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
      onOpen={openSession}
      onDelete={deleteSession}
    />
  );

  return (
    <GlassPanel className="flex h-full flex-col overflow-hidden border-0">
      {/* Header */}
      <div className="border-border/30 flex items-center border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Conversations</h2>
      </div>

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
    </GlassPanel>
  );
}
