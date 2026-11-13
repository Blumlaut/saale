"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { FolderGit2, PanelRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GlassPanel } from "@/components/ui/glass-panel";
import { ChatInterface } from "@/components/chat/chat-interface";
import { SessionSidebar } from "@/components/chat/session-sidebar";
import { ProjectList } from "@/components/coder/project-list";
import { ProvisioningNotice } from "@/components/coder/provisioning-notice";
import { WorktreePanel } from "@/components/coder/worktree-panel";
import {
  usePullRequest,
  useSessionState,
  useCoderChatStarter,
} from "@/components/coder/use-coder-data";
import { CHAT_MIN_WIDTH, useResizableWidth, panelCeiling } from "@/hooks/use-resizable-width";
import { DELETING_POLL_MS } from "@/hooks/use-deleting-poll";
import { useElementWidth } from "@/hooks/use-element-width";
import { isBoolean, usePersistedState } from "@/hooks/use-persisted-state";
import { PanelResizeHandle, PanelResizeSpacer } from "@/components/layout/panel-resize-handle";
import { SESSION_RAIL_WIDTH, SessionPanelSheet } from "@/components/session/session-panel";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

/** How often an open coder chat re-reads its worktree while visible. */
const WORKTREE_POLL_MS = 20_000;

/** How often it re-reads while the workspace is still being built. */
const PROVISIONING_POLL_MS = 2_000;

/** How much history the panel reads at a time, and how much one "load more" adds. */
const COMMITS_PAGE = 20;

/** The ceiling the server enforces on one history read. */
const MAX_COMMITS = 200;

/** The worktree panel's width, remembered per browser. */
const WORKTREE_PANEL = {
  storageKey: "saale.coder.panelWidth",
  label: "Resize the worktree panel",
  defaultWidth: 320,
  minWidth: 280,
  maxWidth: 720,
  handle: "left",
} as const;

/** The chat list's width, remembered per browser. */
const CHAT_SIDEBAR = {
  storageKey: "saale:ui:coder:chatSidebarWidth",
  label: "Resize coder chat list",
  defaultWidth: 256,
  minWidth: 180,
  maxWidth: 400,
  handle: "right",
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
  // How far back the history goes, and whether the last raise is still loading.
  const [commitLimit, setCommitLimit] = useState(COMMITS_PAGE);
  const [loadingMoreCommits, setLoadingMoreCommits] = useState(false);
  const { state, loading, error, gone } = useSessionState(sessionId, refreshKey, commitLimit);
  const { pullRequest } = usePullRequest(sessionId, refreshKey);

  // Another chat has its own history, so the next one opens at the top again.
  useEffect(() => {
    setCommitLimit(COMMITS_PAGE);
    setLoadingMoreCommits(false);
  }, [sessionId]);

  useEffect(() => {
    if (!loading) setLoadingMoreCommits(false);
  }, [loading]);

  const loadMoreCommits = useCallback(() => {
    setLoadingMoreCommits(true);
    setCommitLimit((value) => Math.min(value + COMMITS_PAGE, MAX_COMMITS));
  }, []);

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
    // panel's empty state has to stop claiming there is nothing there. A chat
    // being deleted has to stop showing its worktree the same way.
    const every = state?.deleting
      ? DELETING_POLL_MS
      : provisioningStep
        ? PROVISIONING_POLL_MS
        : WORKTREE_POLL_MS;
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, every);
    const onFocus = () => reload();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [sessionId, reload, provisioningStep, state?.deleting]);

  const [measureRow, rowWidth] = useElementWidth();

  // The panel is a column the user can put away; it stays mounted while hidden
  // so a shell opened in Terminal is still running when it comes back.
  const [panelOpen, setPanelOpen] = usePersistedState("coder:panelOpen", true, {
    validate: isBoolean,
  });
  // The phone's copy of the panel, which is a sheet rather than a column.
  const [panelSheetOpen, setPanelSheetOpen] = useState(false);

  const coderChatSidebar = useResizableWidth({
    ...CHAT_SIDEBAR,
    // The worktree panel keeps its opening width beside the list.
    maxWidth: panelCeiling(
      rowWidth,
      CHAT_MIN_WIDTH + WORKTREE_PANEL.defaultWidth,
      CHAT_SIDEBAR.maxWidth,
    ),
  });

  // An ultrawide leaves room for a worktree panel past the fixed ceiling, so the
  // ceiling is whatever the row holds beyond a usable chat.
  const panel = useResizableWidth({
    ...WORKTREE_PANEL,
    maxWidth: panelCeiling(
      rowWidth,
      coderChatSidebar.width + CHAT_MIN_WIDTH,
      WORKTREE_PANEL.maxWidth,
    ),
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
          <SessionSidebar projectId={projectId} onNewChat={newChat} />
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

  // A chat on its way out has no tabs to offer, so the panel says what is
  // happening instead of folding down to its rail.
  const panelUp = panelOpen || gone || state?.deleting === true;

  return (
    <div className="full-bleed flex min-h-0 flex-1 flex-col">
      <div ref={measureRow} className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className="relative hidden shrink-0 md:block"
          style={{ width: coderChatSidebar.width }}
        >
          <PanelResizeHandle handle={coderChatSidebar.handleProps} placement="edge" />
          <SessionSidebar projectId={projectId} activeSessionId={sessionId} onNewChat={newChat} />
        </div>

        <div className="flex min-w-0 flex-1 flex-col md:ml-4">
          <ChatInterface
            key={sessionId}
            sessionId={sessionId}
            onNewChat={newChat}
            hideTemporaryToggle
            goneHref={`/dashboard/coder/${projectId}`}
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
                    <SessionSidebar
                      projectId={projectId}
                      activeSessionId={sessionId}
                      onNewChat={newChat}
                    />
                  </div>
                </SheetContent>
              </Sheet>
            }
            headerActions={
              <>
                <div className="lg:hidden">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="relative h-8 w-8 md:h-9 md:w-9"
                    aria-label={
                      setupFailure
                        ? "Open worktree panel, the setup script failed"
                        : "Open worktree panel"
                    }
                    onClick={() => setPanelSheetOpen(true)}
                  >
                    <PanelRight className="h-4 w-4" />
                    {/* The panel is behind this button on a phone, so the
                      warning it holds has to show from here. */}
                    {setupFailure && (
                      <span className="bg-destructive absolute top-1 right-1 size-1.5 rounded-full" />
                    )}
                  </Button>
                </div>
                <SessionPanelSheet
                  open={panelSheetOpen}
                  onOpenChange={setPanelSheetOpen}
                  title="Worktree"
                >
                  <WorktreePanel
                    key={sessionId}
                    sessionId={sessionId}
                    state={state}
                    loading={loading}
                    error={error}
                    gone={gone}
                    onRefresh={reload}
                    refreshing={loading}
                    pullRequest={pullRequest}
                    onLoadMoreCommits={loadMoreCommits}
                    loadingMoreCommits={loadingMoreCommits}
                  />
                </SessionPanelSheet>
              </>
            }
          />
        </div>

        {/* Drag to widen the worktree panel; arrow keys do the same from the
            keyboard and the width survives a reload. */}
        {panelUp ? (
          <PanelResizeHandle
            handle={panel.handleProps}
            dragging={panel.dragging}
            className="hidden lg:flex"
          />
        ) : (
          <div className="hidden lg:block">
            <PanelResizeSpacer />
          </div>
        )}
        <div
          className="hidden shrink-0 lg:block"
          style={{ width: panelUp ? panel.width : SESSION_RAIL_WIDTH }}
        >
          <WorktreePanel
            key={sessionId}
            sessionId={sessionId}
            state={state}
            loading={loading}
            error={error}
            gone={gone}
            onRefresh={reload}
            refreshing={loading}
            pullRequest={pullRequest}
            onLoadMoreCommits={loadMoreCommits}
            loadingMoreCommits={loadingMoreCommits}
            collapsed={!panelUp}
            onExpand={() => setPanelOpen(true)}
            onCollapse={() => setPanelOpen(false)}
          />
        </div>
      </div>
    </div>
  );
}
