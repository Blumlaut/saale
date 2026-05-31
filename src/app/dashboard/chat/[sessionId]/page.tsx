import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { MessageSquare } from "lucide-react";

export default function ChatSessionPage({ params }: { params: { sessionId: string } }) {
  return (
    <>
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl leading-tight font-semibold tracking-tight">Chat</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Session {params.sessionId.slice(0, 8)}
          </p>
        </div>
      </div>

      {/* Coming soon */}
      <GlassPanel className="animate-in fade-in slide-in-from-bottom-2 duration-200">
        <GlassPanelContent>
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-white/30 dark:bg-white/5">
              <MessageSquare className="text-muted-foreground/60 h-8 w-8" />
            </div>
            <h2 className="text-base font-medium">Chat interface coming soon</h2>
            <p className="text-muted-foreground mt-1 max-w-sm text-sm">
              The chat interface with Pi streaming is being built.
            </p>
          </div>
        </GlassPanelContent>
      </GlassPanel>
    </>
  );
}
