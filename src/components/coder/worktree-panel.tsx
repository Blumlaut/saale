"use client";

import { useState } from "react";
import { FolderTree, GitBranch, Loader2, SquareTerminal } from "lucide-react";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FileBrowser } from "@/components/files/file-browser";
import { PageTabStrip } from "@/components/layout/page";
import { ChangesView } from "./changes-view";
import { TerminalView } from "./terminal-view";
import type { CoderSessionState } from "./use-coder-data";

/**
 * The right-hand panel: what changed, what is in the worktree, and where the
 * branch stands.
 *
 * A chat that has not sent its first message has no worktree yet, so the panel
 * says that instead of rendering a browser over the wrong directory.
 *
 * The terminal keeps running while another tab is open, so it is mounted
 * alongside the tab contents instead of inside one.
 */
export function WorktreePanel({
  sessionId,
  state,
  loading,
  error,
  onRefresh,
  refreshing,
}: {
  sessionId: string;
  state: CoderSessionState | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [tab, setTab] = useState("changes");

  return (
    <GlassPanel className="flex h-full min-w-0 flex-col overflow-hidden">
      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-0">
        <PageTabStrip className="border-b px-2 py-1.5">
          <TabsList>
            <TabsTrigger value="changes" className="gap-1.5 text-xs">
              <GitBranch className="h-3.5 w-3.5" />
              Project
            </TabsTrigger>
            <TabsTrigger value="files" className="gap-1.5 text-xs">
              <FolderTree className="h-3.5 w-3.5" />
              Files
            </TabsTrigger>
            <TabsTrigger value="terminal" className="gap-1.5 text-xs">
              <SquareTerminal className="h-3.5 w-3.5" />
              Terminal
            </TabsTrigger>
          </TabsList>
        </PageTabStrip>

        <TabsContent value="changes" className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {loading && !state ? (
            <div className="flex items-center gap-2 px-3 py-3">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span className="text-muted-foreground text-xs">Reading the worktree…</span>
            </div>
          ) : error ? (
            <p className="text-destructive px-3 py-3 text-xs break-words">{error}</p>
          ) : !state?.worktree ? (
            <p className="text-muted-foreground px-3 py-3 text-xs">
              The worktree appears after this chat&apos;s first message.
            </p>
          ) : (
            <ChangesView
              sessionId={sessionId}
              state={state}
              onRefresh={onRefresh}
              refreshing={refreshing}
            />
          )}
        </TabsContent>

        <TabsContent value="files" className="min-h-0 flex-1 overflow-hidden">
          {state?.worktree ? (
            <FileBrowser target="user" rootPath={state.worktree.path} dense />
          ) : (
            <p className="text-muted-foreground px-3 py-3 text-xs">
              The worktree appears after this chat&apos;s first message.
            </p>
          )}
        </TabsContent>

        {/* Outside the tab content: a tab switch must not stop a dev server. */}
        <div
          className={
            tab === "terminal"
              ? "flex min-h-0 flex-1 flex-col overflow-hidden"
              : "hidden min-h-0 flex-1 flex-col overflow-hidden"
          }
        >
          <TerminalView
            sessionId={sessionId}
            worktree={
              state?.worktree ? { path: state.worktree.path, branch: state.worktree.branch } : null
            }
          />
        </div>
      </Tabs>
    </GlassPanel>
  );
}
