"use client";

import { useRouter } from "next/navigation";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { MobileSessionSheet } from "./mobile-session-sheet";
import { TemporaryToggle } from "./temporary-toggle";
import { createChatSession } from "@/lib/chat-session";
import { MessageSquarePlus, Ghost } from "lucide-react";

interface ChatEmptyStateProps {
  temporaryMode: boolean;
  onTemporaryChange: (checked: boolean) => void;
}

export function ChatEmptyState({ temporaryMode, onTemporaryChange }: ChatEmptyStateProps) {
  const router = useRouter();

  const handleNewChat = () => {
    createChatSession({ temporary: temporaryMode })
      .then((session) => router.push(`/dashboard/chat/${session.id}`))
      .catch((err) => {
        console.error("Failed to create chat session:", err);
      });
  };

  return (
    <GlassPanel className="flex flex-1 flex-col overflow-hidden rounded-none border-0 md:rounded-2xl">
      {/* Compact control row — session list (mobile) + temporary mode */}
      <div className="border-border/30 flex items-center gap-1.5 border-b px-3 py-1.5 md:px-4">
        <div className="shrink-0 md:hidden">
          <MobileSessionSheet onNewChat={handleNewChat} />
        </div>
        <div className="ml-auto">
          <TemporaryToggle checked={temporaryMode} onChange={onTemporaryChange} />
        </div>
      </div>
      <GlassPanelContent className="flex flex-1 items-center justify-center">
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="bg-accent mb-4 flex h-16 w-16 items-center justify-center rounded-2xl">
            <MessageSquarePlus className="text-muted-foreground h-8 w-8" />
          </div>
          <h2 className="text-base font-medium">Start a conversation</h2>
          <p className="text-muted-foreground mt-1 max-w-sm text-sm">
            Ask questions, brainstorm ideas, or get help with your work.
          </p>
          {temporaryMode && (
            <span className="text-muted-foreground mt-3 flex items-center gap-1.5 text-xs">
              <Ghost className="h-3 w-3" />
              Temporary mode — chat will be deleted on close
            </span>
          )}
          <Button className="liquid-glass-accent mt-6" onClick={handleNewChat}>
            <MessageSquarePlus className="mr-2 h-4 w-4" />
            New Chat
          </Button>
        </div>
      </GlassPanelContent>
    </GlassPanel>
  );
}
