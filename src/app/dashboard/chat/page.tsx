import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { MessageSquarePlus } from "lucide-react";
import Link from "next/link";

export default function ChatPage() {
  return (
    <>
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl leading-tight font-semibold tracking-tight">Chat</h1>
          <p className="text-muted-foreground mt-1 text-sm">Talk with Saale AI</p>
        </div>
      </div>

      {/* Empty state */}
      <GlassPanel className="animate-in fade-in slide-in-from-bottom-2 duration-200">
        <GlassPanelContent>
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-white/30 dark:bg-white/5">
              <MessageSquarePlus className="text-muted-foreground/60 h-8 w-8" />
            </div>
            <h2 className="text-base font-medium">Start a conversation</h2>
            <p className="text-muted-foreground mt-1 max-w-sm text-sm">
              Ask questions, brainstorm ideas, or get help with your work.
            </p>
            <Link href="/dashboard/chat/new" className={cn(buttonVariants(), "mt-6")}>
              <MessageSquarePlus className="h-4 w-4" />
              New Chat
            </Link>
          </div>
        </GlassPanelContent>
      </GlassPanel>
    </>
  );
}
