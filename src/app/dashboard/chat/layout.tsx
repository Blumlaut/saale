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
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg leading-tight font-semibold tracking-tight md:text-2xl">Chat</h1>
          <p className="text-muted-foreground mt-1 text-xs md:text-sm">
            Ask questions, brainstorm ideas, or get help with your work
          </p>
        </div>
        <Button
          className="liquid-glass-accent h-8 w-8 rounded-full md:h-9 md:w-auto md:px-3"
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

      {/* Content: sidebar + main */}
      <div className="flex h-[calc(100vh-9rem)] gap-4 md:h-[calc(100vh-8rem)]">
        {/* Sidebar — desktop only */}
        <div className="hidden w-64 shrink-0 md:block">
          <SessionSidebar {...(sessionId ? { activeSessionId: sessionId } : {})} />
        </div>

        {/* Mobile: session list in a sheet */}
        <div className="md:hidden">
          <Sheet>
            <SheetTrigger>
              <span className="inline-flex h-8 w-8 items-center justify-center rounded transition-colors hover:bg-white/10 dark:hover:bg-white/5">
                <PanelLeft className="h-4 w-4" />
              </span>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 p-0 sm:w-80">
              <div className="h-full">
                <SessionSidebar {...(sessionId ? { activeSessionId: sessionId } : {})} />
              </div>
            </SheetContent>
          </Sheet>
        </div>

        {/* Main area — layout controls which view is shown */}
        <div className="flex flex-1">
          {sessionId ? <ChatInterface sessionId={sessionId} /> : <ChatEmptyState />}
        </div>
      </div>
    </div>
  );
}
