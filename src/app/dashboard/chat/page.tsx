"use client";

import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { createChatSession } from "@/lib/chat-session";
import { MessageSquarePlus } from "lucide-react";

export default function ChatPage() {
  return (
    <>
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
            window.location.href = `/dashboard/chat/${session.id}`;
          }}
        >
          <MessageSquarePlus className="h-4 w-4" />
          <span className="hidden md:inline">New Chat</span>
        </Button>
      </div>

      {/* Empty state */}
      <GlassPanel className="liquid-glass flex flex-1 flex-col border-0 bg-transparent">
        <GlassPanelContent className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-white/30 dark:bg-white/5">
              <MessageSquarePlus className="text-muted-foreground/60 h-8 w-8" />
            </div>
            <h2 className="text-base font-medium">Start a conversation</h2>
            <p className="text-muted-foreground mt-1 max-w-sm text-sm">
              Ask questions, brainstorm ideas, or get help with your work.
            </p>
            <Button
              className="liquid-glass-accent mt-6"
              onClick={async () => {
                const session = await createChatSession();
                window.location.href = `/dashboard/chat/${session.id}`;
              }}
            >
              <MessageSquarePlus className="mr-2 h-4 w-4" />
              New Chat
            </Button>
          </div>
        </GlassPanelContent>
      </GlassPanel>
    </>
  );
}
