"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { fetchJson, deleteJson } from "@/lib/http";
import { Trash2, Loader2, Ghost, GitBranch } from "lucide-react";

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

export function SessionSidebar({ activeSessionId }: { activeSessionId?: string }) {
  const router = useRouter();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    try {
      const data = await fetchJson<{ sessions: ChatSession[] }>("/api/chat/sessions");
      setSessions(data.sessions);
    } catch {
      // Ignore
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
    } catch {
      // Ignore
    }
    setDeletingId(null);
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 7) return `${days} days ago`;
    return date.toLocaleDateString();
  };

  return (
    <GlassPanel className="flex h-full flex-col overflow-hidden border-0">
      {/* Header */}
      <div className="border-border/30 flex items-center border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Conversations</h2>
      </div>

      {/* Session list */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
          </div>
        ) : sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <p className="text-muted-foreground text-sm">No conversations yet</p>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-2 py-1">
            {sessions.map((session) => (
              <div
                key={session.id}
                className={cn(
                  "group relative flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors duration-150",
                  session.id === activeSessionId ? "bg-accent/70" : "hover:bg-accent/60",
                )}
              >
                <button
                  className="flex min-w-0 flex-1 flex-col items-start text-left"
                  onClick={() => router.push(`/dashboard/chat/${session.id}`)}
                >
                  <div className="flex items-center gap-1.5">
                    <div className="truncate font-medium">
                      {session.title.length > 25 ? `${session.title.slice(0, 25)}…` : session.title}
                    </div>
                    {session.isGenerating && (
                      <span className="text-muted-foreground animate-pulse-dot -ml-0.5 h-1 w-1 shrink-0 rounded-full bg-current" />
                    )}
                    {session.forkedFromSessionId && (
                      <GitBranch className="text-muted-foreground h-3 w-3 shrink-0" />
                    )}
                    {session.temporary && (
                      <Ghost className="text-muted-foreground h-3 w-3 shrink-0" />
                    )}
                  </div>
                  <div className="text-muted-foreground truncate text-xs">
                    {formatDate(session.lastActivityAt ?? session.updatedAt)} ·{" "}
                    {session.messageCount} messages
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
                    deleteSession(session.id);
                  }}
                  disabled={deletingId === session.id}
                >
                  {deletingId === session.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Trash2 className="h-3 w-3" />
                  )}
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </GlassPanel>
  );
}
