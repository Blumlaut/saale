"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { SessionSidebar } from "@/components/chat/session-sidebar";
import { usePersistedState } from "@/hooks/use-persisted-state";
import { ChatEmptyState } from "@/components/chat/chat-empty-state";
import { ChatInterface } from "@/components/chat/chat-interface";
import { patchJson } from "@/lib/http";
import { createChatSession } from "@/lib/chat-session";

export default function ChatLayout({ children: _children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const segments = pathname.split("/");
  const sessionId = segments.length >= 4 && segments[3] ? segments[3] : null;
  const [chatSidebarWidth, setChatSidebarWidth] = usePersistedState("chat:sidebarWidth", 224, {
    validate: (v): v is number => typeof v === "number" && v >= 180 && v <= 400,
  });
  const resizingChat = useRef(false);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizingChat.current) return;
      const newW = Math.min(400, Math.max(180, e.clientX - 24));
      setChatSidebarWidth(newW);
    };
    const onUp = () => {
      resizingChat.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [setChatSidebarWidth]);

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
    } catch (err) {
      console.error("Failed to sync temporary mode:", err);
    }
  }, []);

  useEffect(() => {
    if (sessionId) {
      syncTemporary(sessionId);
    }
  }, [sessionId, syncTemporary]);

  // Toggle handler. patches current session if one is active
  const handleToggleTemporary = useCallback(
    async (checked: boolean) => {
      setTemporaryMode(checked);
      if (sessionId) {
        try {
          await patchJson(`/api/chat/sessions/${sessionId}`, { temporary: checked });
        } catch (err) {
          console.error("Failed to update temporary mode:", err);
        }
      }
    },
    [sessionId],
  );

  const handleNewChat = useCallback(() => {
    createChatSession({ temporary: temporaryMode })
      .then((session) => router.push(`/dashboard/chat/${session.id}`))
      .catch((err) => {
        console.error("Failed to create chat session:", err);
      });
  }, [router, temporaryMode]);

  return (
    <div className="full-bleed flex min-h-0 flex-1 flex-col">
      {/* Content: sidebar + main. edge to edge on phones, console gutter on
          desktop (see `.full-bleed` in globals.css) */}
      <div className="flex min-h-0 flex-1 gap-3 overflow-hidden">
        {/* Sidebar. desktop only */}
        <div className="hidden shrink-0 md:block relative" style={{ width: chatSidebarWidth }}>
          <div
            className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/40"
            onMouseDown={() => {
              resizingChat.current = true;
              document.body.style.cursor = "col-resize";
              document.body.style.userSelect = "none";
            }}
          />
          <SessionSidebar {...(sessionId ? { activeSessionId: sessionId } : {})} />
        </div>

        {/* Main area. flex column so ChatInterface can flex-1 to fill height */}
        <div className="flex min-w-0 flex-1 flex-col">
          {sessionId ? (
            <ChatInterface
              key={sessionId}
              sessionId={sessionId}
              temporaryMode={temporaryMode}
              onTemporaryChange={handleToggleTemporary}
              onNewChat={handleNewChat}
            />
          ) : (
            <ChatEmptyState
              temporaryMode={temporaryMode}
              onTemporaryChange={handleToggleTemporary}
            />
          )}
        </div>
      </div>
    </div>
  );
}
