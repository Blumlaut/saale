"use client";

import { useRouter, usePathname } from "next/navigation";
import { SessionSidebar } from "@/components/chat/session-sidebar";
import { ChatEmptyState } from "@/components/chat/chat-empty-state";
import { ChatInterface } from "@/components/chat/chat-interface";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { PanelLeft, MessageSquarePlus } from "lucide-react";
import { createChatSession } from "@/lib/chat-session";

export default function ChatLayout({ children: _children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const segments = pathname.split("/");
  const sessionId = segments.length >= 4 && segments[3] ? segments[3] : null;
  return (
    <div className="flex h-dvh flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-4">
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
        <Button
          className="liquid-glass-accent h-8 w-8 shrink-0 rounded-full md:h-9 md:w-auto md:px-3"
          size="icon"
          onClick={async () => {
            const session = await createChatSession();
            router.push(`/dashboard/chat/${session.id}`);
          }}
        >
          <MessageSquarePlus className="h-4 w-4" />
          <span className="hidden md:inline">New Chat</span>
        </Button>
      </div>

      {/* Content: sidebar + main — flex-1 fills remaining viewport, overflow contained */}
      <div className="flex min-h-0 flex-1 gap-4 overflow-hidden p-4">
        {/* Sidebar — desktop only */}
        <div className="hidden w-64 shrink-0 md:block">
          <SessionSidebar {...(sessionId ? { activeSessionId: sessionId } : {})} />
        </div>

        {/* Main area — layout controls which view is shown */}
        <div className="min-w-0 flex-1">
          {sessionId ? <ChatInterface sessionId={sessionId} /> : <ChatEmptyState />}
        </div>
      </div>
    </div>
  );
}
