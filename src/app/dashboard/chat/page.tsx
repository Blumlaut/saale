"use client";

import { SessionSidebar } from "@/components/chat/session-sidebar";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { MessageSquarePlus } from "lucide-react";
import Link from "next/link";

export default function ChatPage() {
  return (
    <div className="flex h-[calc(100vh-8rem)] gap-4">
      {/* Sidebar */}
      <div className="w-64 shrink-0">
        <SessionSidebar />
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
            <Link
              href="/api/chat/sessions"
              className="mt-6 inline-flex"
              onClick={async (e) => {
                e.preventDefault();
                const res = await fetch("/api/chat/sessions", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ title: "New Chat" }),
                });
                if (res.ok) {
                  const data = await res.json();
                  window.location.href = `/dashboard/chat/${data.session.id}`;
                }
              }}
            >
              <Button>
                <MessageSquarePlus className="mr-2 h-4 w-4" />
                New Chat
              </Button>
            </Link>
          </div>
        </GlassPanelContent>
      </GlassPanel>
    </div>
  );
}
