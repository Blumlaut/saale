"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MessageSquarePlus, Trash2, Loader2 } from "lucide-react";

interface ChatSession {
  id: string;
  title: string;
  messageCount: number;
  updatedAt: string;
}

export function SessionSidebar({ activeSessionId }: { activeSessionId?: string }) {
  const router = useRouter();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    fetchSessions();
  }, []);

  const fetchSessions = async () => {
    try {
      const res = await fetch("/api/chat/sessions");
      if (res.ok) {
        const data = await res.json();
        setSessions(data.sessions);
      }
    } catch {
      // Ignore
    } finally {
      setLoading(false);
    }
  };

  const createSession = async () => {
    // Fetch user settings for default model
    let settings: {
      defaultModelProvider?: string;
      defaultModelName?: string;
      defaultThinkingLevel?: string;
    } | null = null;
    try {
      const res = await fetch("/api/settings");
      if (res.ok) {
        const data = await res.json();
        settings = data.settings ?? null;
      }
    } catch {
      // Ignore — session will be created without model info
    }

    const res = await fetch("/api/chat/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "New Chat",
        modelProvider: settings?.defaultModelProvider || undefined,
        modelName: settings?.defaultModelName || undefined,
        thinkingLevel: settings?.defaultThinkingLevel || "off",
      }),
    });

    if (res.ok) {
      const data = await res.json();
      router.push(`/dashboard/chat/${data.session.id}`);
      await fetchSessions();
    }
  };

  const deleteSession = async (id: string) => {
    setDeletingId(id);
    const res = await fetch(`/api/chat/sessions/${id}`, {
      method: "DELETE",
    });

    if (res.ok) {
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (activeSessionId === id) {
        router.push("/dashboard/chat");
      }
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
    <div className="flex h-full flex-col gap-3">
      {/* New chat button */}
      <Button onClick={createSession} className="w-full gap-2 rounded-xl" variant="default">
        <MessageSquarePlus className="h-4 w-4" />
        New Chat
      </Button>

      {/* Session list */}
      <GlassPanel className="flex flex-1 flex-col overflow-hidden">
        <GlassPanelContent className="flex flex-1 flex-col gap-0 overflow-hidden p-0">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
            </div>
          ) : sessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <p className="text-muted-foreground text-sm">No conversations yet</p>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto">
              {sessions.map((session) => (
                <div
                  key={session.id}
                  className={cn(
                    "group border-border/30 flex items-center gap-2 px-3 py-2.5 text-sm transition-colors hover:bg-white/20 dark:hover:bg-white/5",
                    session.id === activeSessionId && "bg-white/20 dark:bg-white/5",
                  )}
                >
                  <button
                    className="flex-1 text-left"
                    onClick={() => router.push(`/dashboard/chat/${session.id}`)}
                  >
                    <div className="truncate font-medium">{session.title}</div>
                    <div className="text-muted-foreground text-xs">
                      {formatDate(session.updatedAt)} · {session.messageCount} messages
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
        </GlassPanelContent>
      </GlassPanel>
    </div>
  );
}
