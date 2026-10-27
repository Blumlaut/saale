"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { FolderGit2, PanelRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ChatInterface } from "@/components/chat/chat-interface";
import { ProjectChats } from "@/components/coder/project-chats";
import { ProjectList } from "@/components/coder/project-list";
import { ProvisioningNotice } from "@/components/coder/provisioning-notice";
import { WorktreePanel } from "@/components/coder/worktree-panel";
import { useSessionState, useCoderChatStarter } from "@/components/coder/use-coder-data";
import { useResizableWidth } from "@/hooks/use-resizable-width";

/** How often an open coder chat re-reads its worktree while visible. */
const WORKTREE_POLL_MS = 20_000;

/** How often it re-reads while the workspace is still being built. */
const PROVISIONING_POLL_MS = 2_000;

/** The worktree panel's width, remembered per browser. */
const WORKTREE_PANEL = {
  storageKey: "saale.coder.panelWidth",
  label: "Resize the worktree panel",
  defaultWidth: 320,
  minWidth: 280,
  maxWidth: 720,
  handle: "left",
} as const;

export default function CoderLayout() {
  const pathname = usePathname();
  const startChat = useCoderChatStarter();
  const segments = pathname.split("/").filter(Boolean);
  const projectId = segments[2] ?? null;
  const sessionId = segments[3] ?? null;

  // Bumped whenever the panel should re-read git: the poll, a focus, the
  // refresh button, and every time a run starts so the first changes appear
  // without waiting for the next tick.
  const [refreshKey, setRefreshKey] = useState(0);
  const reload = useCallback(() => setRefreshKey((value) => value + 1), []);
  const { state, loading, error } = useSessionState(sessionId, refreshKey);
  const panel = useResizableWidth(WORKTREE_PANEL);

  // The step, not the record: every poll re-fetches, so depending on the
  // object would restart the timer on each answer and never keep a cadence.
  const provisioningStep = state?.provisioning?.step ?? null;

  // A build that ran the setup script and failed. The worktree panel carries
  // it, because that is the panel that says what the checkout is missing, and on
  // phones that panel is behind a button, so the button wears the warning too.
  const setupFailure = state?.setupFailure ?? null;

  useEffect(() => {
    if (!sessionId) return;
    // Building a workspace is a minute-long event, not a background change: the
    // panel's empty state has to stop claiming there is nothing there.
    const interval = setInterval(
      () => {
        if (document.visibilityState === "visible") reload();
      },
      provisioningStep ? PROVISIONING_POLL_MS : WORKTREE_POLL_MS,
    );
    const onFocus = () => reload();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [sessionId, reload, provisioningStep]);

  const coderChatSidebar = useResizableWidth({
    storageKey: "saale:ui:coder:chatSidebarWidth",
    label: "Resize coder chat list",
    defaultWidth: 256,
    minWidth: 180,
    maxWidth: 400,
    handle: "right",
  });

  const newChat = useCallback(() => {
    if (projectId) startChat(projectId);
  }, [projectId, startChat]);

  if (!projectId) return <ProjectList />;

  if (!sessionId) {
    return (
      <div className="flex min-h-0 flex-1 gap-4 overflow-hidden">
        {/* Phones show only the chat list; the header button starts a new
            chat, so the empty state only earns its half at md and up. */}
        <div className="min-w-0 flex-1 md:w-64 md:flex-none">
          <ProjectChats projectId={projectId} onNewChat={newChat} />
        </div>
        <div className="hidden min-w-0 flex-1 md:block">
          <GlassPanel className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <FolderGit2 className="text-muted-foreground h-8 w-8" />
            <p className="text-sm font-medium">No chat open</p>
            <p className="text-muted-foreground max-w-sm text-sm">
              A chat works in a checkout of the project, with a terminal and the files it changed
              beside it.
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
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className="relative hidden shrink-0 md:block"
          style={{ width: coderChatSidebar.width }}
        >
          <div
            {...coderChatSidebar.handleProps}
            className="hover:bg-border absolute top-0 right-0 z-10 h-full w-1.5 cursor-col-resize"
          />
          <ProjectChats projectId={projectId} activeSessionId={sessionId} onNewChat={newChat} />
        </div>

        <div className="flex min-w-0 flex-1 flex-col md:ml-4">
          <ChatInterface
            key={sessionId}
            sessionId={sessionId}
            onNewChat={newChat}
            hideTemporaryToggle
            renderWaitingNotice={(waiting) => (
              <ProvisioningNotice sessionId={sessionId} waiting={waiting} />
            )}
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
                  <SheetTrigger
                    aria-label={
                      setupFailure
                        ? "Open worktree panel, the setup script failed"
                        : "Open worktree panel"
                    }
                  >
                    <span className="hover:bg-accent/60 relative inline-flex h-8 w-8 items-center justify-center rounded transition-colors md:h-9 md:w-9">
                      <PanelRight className="h-4 w-4" />
                      {/* The panel is behind this button on a phone, so the
                          warning it holds has to show from here. */}
                      {setupFailure && (
                        <span className="bg-destructive absolute top-1 right-1 size-1.5 rounded-full" />
                      )}
                    </span>
                  </SheetTrigger>
                  <SheetContent side="right" className="w-4/5 max-w-[380px] p-0">
                    <SheetHeader className="sr-only">
                      <SheetTitle>Worktree</SheetTitle>
                    </SheetHeader>
                    <div className="h-full">
                      <WorktreePanel
                        key={sessionId}
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

        {/* Drag to widen the worktree panel; arrow keys do the same from the
            keyboard and the width survives a reload. */}
        <div
          {...panel.handleProps}
          className={cn(
            "group hover:bg-border focus-visible:ring-ring mx-1 hidden w-1.5 shrink-0 cursor-col-resize touch-none items-center justify-center rounded-full transition-colors focus-visible:ring-2 focus-visible:outline-none lg:flex",
            panel.dragging && "bg-border",
          )}
        />
        <div className="hidden shrink-0 lg:block" style={{ width: panel.width }}>
          <WorktreePanel
            key={sessionId}
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
