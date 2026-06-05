"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { SessionSidebar } from "@/components/chat/session-sidebar";
import { ChatEmptyState } from "@/components/chat/chat-empty-state";
import { ChatInterface } from "@/components/chat/chat-interface";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { patchJson } from "@/lib/http";
import { PanelLeft, MessageSquarePlus, Ghost } from "lucide-react";
import { createChatSession } from "@/lib/chat-session";

export default function ChatLayout({ children: _children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const segments = pathname.split("/");
  const sessionId = segments.length >= 4 && segments[3] ? segments[3] : null;
  const streamUrl = searchParams.get("streamUrl");

  // `temporaryMode` controls whether new chats are temporary.
  // When inside a session it reflects that session's `temporary` flag.
  const [temporaryMode, setTemporaryMode] = useState(false);

  // Sync toggle with current session's temporary flag
  const syncTemporary = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/chat/sessions/${id}`);
      const data = await res.json();
      if (data.session?.temporary !== undefined) {
        setTemporaryMode(data.session.temporary);
      }
    } catch {
      // Ignore
    }
  }, []);

  useEffect(() => {
    if (sessionId) {
      syncTemporary(sessionId);
    }
  }, [sessionId, syncTemporary]);

  // Toggle handler — patches current session if one is active
  const handleToggleTemporary = useCallback(
    async (checked: boolean) => {
      setTemporaryMode(checked);
      if (sessionId) {
        try {
          await patchJson(`/api/chat/sessions/${sessionId}`, { temporary: checked });
        } catch {
          // Silently fail — local state is already updated
        }
      }
    },
    [sessionId],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-start justify-between gap-4 pb-2 md:pb-4">
        <div className="flex items-center gap-2">
          {/* Mobile: session list in a sheet — lives in header, not content */}
          <div className="md:hidden">
            <Sheet>
              <SheetTrigger>
                <span className="inline-flex h-8 w-8 items-center justify-center rounded transition-colors hover:bg-white/10 dark:hover:bg-white/5">
                  <PanelLeft className="h-4 w-4" />
                </span>
              </SheetTrigger>
              <SheetContent side="left" className="w-4/5 max-w-[280px] p-0">
                <div className="h-full">
                  <SessionSidebar {...(sessionId ? { activeSessionId: sessionId } : {})} />
                </div>
              </SheetContent>
            </Sheet>
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-lg leading-tight font-semibold tracking-tight md:text-2xl">
              Chat
            </h1>
            <p className="text-muted-foreground mt-1 text-xs md:text-sm">
              Ask questions, brainstorm ideas, or get help with your work
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Temporary toggle */}
          <div className="flex items-center gap-1.5 rounded-full px-2 py-1 transition-colors hover:bg-white/10 dark:hover:bg-white/5">
            <Ghost
              className={
                "h-3.5 w-3.5 transition-colors " +
                (temporaryMode ? "text-foreground" : "text-muted-foreground")
              }
            />
            <Switch
              size="sm"
              checked={temporaryMode}
              onCheckedChange={handleToggleTemporary}
              title="Temporary chat — auto-deleted on close"
            />
          </div>
          <Button
            className="liquid-glass-accent h-8 w-8 shrink-0 rounded-full md:h-9 md:w-auto md:px-3"
            size="icon"
            onClick={async () => {
              const session = await createChatSession({ temporary: temporaryMode });
              router.push(`/dashboard/chat/${session.id}`);
            }}
          >
            <MessageSquarePlus className="h-4 w-4" />
            <span className="hidden md:inline">New Chat</span>
          </Button>
        </div>
      </div>

      {/* Content: sidebar + main — flex-1 fills remaining viewport, overflow contained */}
      <div className="flex min-h-0 flex-1 gap-4 overflow-hidden px-2 py-4 md:px-4">
        {/* Sidebar — desktop only */}
        <div className="hidden w-64 shrink-0 md:block">
          <SessionSidebar {...(sessionId ? { activeSessionId: sessionId } : {})} />
        </div>

        {/* Main area — flex column so ChatInterface can flex-1 to fill height */}
        <div className="flex min-w-0 flex-1 flex-col">
          {sessionId ? (
            <ChatInterface
              sessionId={sessionId}
              temporaryMode={temporaryMode}
              {...(streamUrl && { initialStreamUrl: streamUrl })}
            />
          ) : (
            <ChatEmptyState temporaryMode={temporaryMode} />
          )}
        </div>
      </div>
    </div>
  );
}
