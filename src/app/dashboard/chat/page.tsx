"use client";

import { SessionSidebar } from "@/components/chat/session-sidebar";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { MessageSquarePlus, PanelLeft } from "lucide-react";

export default function ChatPage() {
  return (
    <div className="flex h-[calc(100vh-8rem)] gap-4 md:h-[calc(100vh-7rem)]">
      {/* Sidebar — desktop only */}
      <div className="hidden w-64 shrink-0 md:block">
        <SessionSidebar />
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
              <SessionSidebar />
            </div>
          </SheetContent>
        </Sheet>
      </div>

      {/* Main area */}
      <GlassPanel className="flex flex-1 flex-col">
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
              className="mt-6"
              onClick={async () => {
                // Fetch user settings for default model
                let settings: {
                  defaultModelProvider?: string;
                  defaultModelName?: string;
                  defaultThinkingLevel?: string;
                } | null = null;
                try {
                  const res = await fetch("/api/settings");
                  if (res.ok) {
                    const data = await res.json();
                    settings = data.settings ?? null;
                  }
                } catch {
                  // Ignore
                }

                const res = await fetch("/api/chat/sessions", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    title: "New Chat",
                    modelProvider: settings?.defaultModelProvider || undefined,
                    modelName: settings?.defaultModelName || undefined,
                    thinkingLevel: settings?.defaultThinkingLevel || "off",
                  }),
                });
                if (res.ok) {
                  const data = await res.json();
                  window.location.href = `/dashboard/chat/${data.session.id}`;
                }
              }}
            >
              <MessageSquarePlus className="mr-2 h-4 w-4" />
              New Chat
            </Button>
          </div>
        </GlassPanelContent>
      </GlassPanel>
    </div>
  );
}
