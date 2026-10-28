"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { SessionSidebar } from "@/components/chat/session-sidebar";
import { useResizableWidth } from "@/hooks/use-resizable-width";
import { ChatEmptyState } from "@/components/chat/chat-empty-state";
import { ChatInterface } from "@/components/chat/chat-interface";
import { patchJson } from "@/lib/http";
import { createChatSession, startChatSession } from "@/lib/chat-session";
import { PROMPT_PARAM, readPromptParam } from "@/lib/chat/prompt-param";

export default function ChatLayout({ children: _children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const segments = pathname.split("/");
  const sessionId = segments.length >= 4 && segments[3] ? segments[3] : null;
  const chatSidebar = useResizableWidth({
    storageKey: "saale:ui:chat:sidebarWidth",
    label: "Resize chat list",
    defaultWidth: 224,
    minWidth: 180,
    maxWidth: 400,
    handle: "right",
  });

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

  // A browser opened this route with a prompt in the URL, the way Firefox's AI
  // chatbot sidebar hands selected text to its provider. The chat starts on its
  // own, and the prompt leaves the URL so a reload starts nothing new.
  const prompt = searchParams.get(PROMPT_PARAM);
  const promptStarted = useRef<string | null>(null);
  const [startingFromPrompt, setStartingFromPrompt] = useState(false);

  useEffect(() => {
    const message = readPromptParam(prompt);
    if (!message || sessionId || promptStarted.current === prompt) return;

    promptStarted.current = prompt;
    setStartingFromPrompt(true);
    startChatSession({ message, temporary: temporaryMode })
      .then((session) => router.replace(`/dashboard/chat/${session.id}`))
      .catch((err: unknown) => {
        console.error("Failed to start a chat from a prompt:", err);
        setStartingFromPrompt(false);
        toast.error("Could not start the chat");
      });
  }, [prompt, sessionId, router, temporaryMode]);

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
        <div className="relative hidden shrink-0 md:block" style={{ width: chatSidebar.width }}>
          <div
            {...chatSidebar.handleProps}
            className="hover:bg-border absolute top-0 right-0 z-10 h-full w-1.5 cursor-col-resize"
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
              starting={startingFromPrompt}
            />
          )}
        </div>
      </div>
    </div>
  );
}
