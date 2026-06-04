"use client";

import { useRouter } from "next/navigation";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { createChatSession } from "@/lib/chat-session";
import { MessageSquarePlus, Ghost } from "lucide-react";

export function ChatEmptyState({ temporaryMode }: { temporaryMode: boolean }) {
  const router = useRouter();

  return (
    <GlassPanel className="flex flex-1 flex-col border-0">
      <GlassPanelContent className="flex flex-1 items-center justify-center">
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-white/30 dark:bg-white/5">
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
          <Button
            className="liquid-glass-accent mt-6"
            onClick={async () => {
              const session = await createChatSession({ temporary: temporaryMode });
              router.push(`/dashboard/chat/${session.id}`);
            }}
          >
            <MessageSquarePlus className="mr-2 h-4 w-4" />
            New Chat
          </Button>
        </div>
      </GlassPanelContent>
    </GlassPanel>
  );
}
