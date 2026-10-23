"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { FolderGit2, PanelRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ChatInterface } from "@/components/chat/chat-interface";
import { ProjectChats } from "@/components/coder/project-chats";
import { ProjectList } from "@/components/coder/project-list";
import { WorktreePanel } from "@/components/coder/worktree-panel";
import { useSessionState } from "@/components/coder/use-coder-data";
import { createChatSession } from "@/lib/chat-session";

/** How often an open coder chat re-reads its worktree while visible. */
const WORKTREE_POLL_MS = 20_000;

export default function CoderLayout() {
  const pathname = usePathname();
  const router = useRouter();
  const segments = pathname.split("/").filter(Boolean);
  const projectId = segments[2] ?? null;
  const sessionId = segments[3] ?? null;

  // Bumped whenever the panel should re-read git: the poll, a focus, the
  // refresh button, and every time a run starts so the first changes appear
  // without waiting for the next tick.
  const [refreshKey, setRefreshKey] = useState(0);
  const reload = useCallback(() => setRefreshKey((value) => value + 1), []);
  const { state, loading, error } = useSessionState(sessionId, refreshKey);

  useEffect(() => {
    if (!sessionId) return;
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, WORKTREE_POLL_MS);
    const onFocus = () => reload();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [sessionId, reload]);

  const newChat = useCallback(() => {
    if (!projectId) return;
    createChatSession({ projectId })
      .then((session) => router.push(`/dashboard/coder/${projectId}/${session.id}`))
      .catch((err: unknown) => {
        console.error("Failed to create a coder chat:", err);
      });
  }, [projectId, router]);

  if (!projectId) return <ProjectList />;

  if (!sessionId) {
    return (
      <div className="flex min-h-0 flex-1 gap-4 overflow-hidden">
        <div className="w-64 shrink-0">
          <ProjectChats projectId={projectId} onNewChat={newChat} />
        </div>
        <div className="min-w-0 flex-1">
          <GlassPanel className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <FolderGit2 className="text-muted-foreground h-8 w-8" />
            <p className="text-sm font-medium">No chat open</p>
            <p className="text-muted-foreground max-w-sm text-sm">
              Each chat gets its own worktree.
            </p>
            <Button size="sm" onClick={newChat}>
              New coder chat
            </Button>
          </GlassPanel>
        </div>
      </div>
    );
  }

  return (
    <div className="full-bleed flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 gap-4 overflow-hidden">
        <div className="hidden w-64 shrink-0 md:block">
          <ProjectChats projectId={projectId} activeSessionId={sessionId} onNewChat={newChat} />
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <ChatInterface
            key={sessionId}
            sessionId={sessionId}
            onNewChat={newChat}
            hideTemporaryToggle
            mobileListTrigger={
              <Sheet>
                <SheetTrigger aria-label="Open chat list">
                  <span className="hover:bg-accent/60 inline-flex h-8 w-8 items-center justify-center rounded transition-colors">
                    <FolderGit2 className="h-4 w-4" />
                  </span>
                </SheetTrigger>
                <SheetContent side="left" className="w-4/5 max-w-[280px] p-0">
                  <SheetHeader className="sr-only">
                    <SheetTitle>Project chats</SheetTitle>
                  </SheetHeader>
                  <div className="h-full">
                    <ProjectChats
                      projectId={projectId}
                      activeSessionId={sessionId}
                      onNewChat={newChat}
                    />
                  </div>
                </SheetContent>
              </Sheet>
            }
            headerActions={
              <div className="lg:hidden">
                <Sheet>
                  <SheetTrigger aria-label="Open worktree panel">
                    <span className="hover:bg-accent/60 inline-flex h-8 w-8 items-center justify-center rounded transition-colors md:h-9 md:w-9">
                      <PanelRight className="h-4 w-4" />
                    </span>
                  </SheetTrigger>
                  <SheetContent side="right" className="w-4/5 max-w-[380px] p-0">
                    <SheetHeader className="sr-only">
                      <SheetTitle>Worktree</SheetTitle>
                    </SheetHeader>
                    <div className="h-full">
                      <WorktreePanel
                        sessionId={sessionId}
                        state={state}
                        loading={loading}
                        error={error}
                        onRefresh={reload}
                        refreshing={loading}
                      />
                    </div>
                  </SheetContent>
                </Sheet>
              </div>
            }
          />
        </div>

        <div className="hidden w-80 shrink-0 lg:block xl:w-96">
          <WorktreePanel
            sessionId={sessionId}
            state={state}
            loading={loading}
            error={error}
            onRefresh={reload}
            refreshing={loading}
          />
        </div>
      </div>
    </div>
  );
}
