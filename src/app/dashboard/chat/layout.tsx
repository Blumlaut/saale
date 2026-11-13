"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { SessionSidebar } from "@/components/chat/session-sidebar";
import { CHAT_MIN_WIDTH, useResizableWidth, panelCeiling } from "@/hooks/use-resizable-width";
import { useElementWidth } from "@/hooks/use-element-width";
import { PanelResizeHandle } from "@/components/layout/panel-resize-handle";
import { ChatEmptyState } from "@/components/chat/chat-empty-state";
import { ChatInterface } from "@/components/chat/chat-interface";
import { TemporaryToggle } from "@/components/chat/temporary-toggle";
import { cn } from "@/lib/utils";
import { patchJson } from "@/lib/http";
import { createChatSession, startChatSession } from "@/lib/chat-session";
import { PROMPT_PARAM, readPromptParam } from "@/lib/chat/prompt-param";

/** The chat list's width, remembered per browser. */
const CHAT_SIDEBAR = {
  storageKey: "saale:ui:chat:sidebarWidth",
  label: "Resize chat list",
  defaultWidth: 224,
  minWidth: 180,
  maxWidth: 400,
  handle: "right",
} as const;

export default function ChatLayout({ children: _children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const segments = pathname.split("/");
  const sessionId = segments.length >= 4 && segments[3] ? segments[3] : null;
  const [measureRow, rowWidth] = useElementWidth();
  const chatSidebar = useResizableWidth({
    ...CHAT_SIDEBAR,
    maxWidth: panelCeiling(rowWidth, CHAT_MIN_WIDTH, CHAT_SIDEBAR.maxWidth),
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
      <div ref={measureRow} className="flex min-h-0 flex-1 gap-3 overflow-hidden">
        {/* The chat list is the phone's landing view, so an existing chat is one
            tap away; opening one hands the screen to it. Desktop keeps the list
            as a column beside the conversation. */}
        <div
          className={cn(
            "relative min-h-0 min-w-0",
            sessionId
              ? "hidden md:block md:shrink-0"
              : "flex flex-1 flex-col md:block md:flex-none",
          )}
          style={{ width: chatSidebar.width }}
        >
          <PanelResizeHandle
            handle={chatSidebar.handleProps}
            placement="edge"
            className="hidden md:block"
          />
          <SessionSidebar
            {...(sessionId ? { activeSessionId: sessionId } : {})}
            onNewChat={handleNewChat}
            headerAction={
              sessionId ? undefined : (
                <TemporaryToggle checked={temporaryMode} onChange={handleToggleTemporary} />
              )
            }
          />
        </div>

        {/* Main area. flex column so ChatInterface can flex-1 to fill height */}
        <div className={cn("flex min-w-0 flex-1 flex-col", !sessionId && "hidden md:flex")}>
          {sessionId ? (
            <ChatInterface
              key={sessionId}
              sessionId={sessionId}
              temporaryMode={temporaryMode}
              onTemporaryChange={handleToggleTemporary}
              onNewChat={handleNewChat}
              sessionPanel
            />
          ) : (
            <ChatEmptyState temporaryMode={temporaryMode} starting={startingFromPrompt} />
          )}
        </div>
      </div>
    </div>
  );
}
