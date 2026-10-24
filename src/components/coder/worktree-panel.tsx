"use client";

import { useRef, useState } from "react";
import { FolderTree, GitBranch, Globe, Loader2, SquareTerminal } from "lucide-react";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FileBrowser } from "@/components/files/file-browser";
import { PageTabStrip } from "@/components/layout/page";
import { ChangesView } from "./changes-view";
import { PortsView } from "./ports-view";
import { PROVISIONING_STEP_COPY } from "./provisioning-copy";
import { SetupFailureNotice } from "./setup-failure-notice";
import { TerminalView } from "./terminal-view";
import type { CoderProvisioning, CoderSessionState } from "./use-coder-data";
import { usePorts } from "./use-ports";

function NoWorktree({ provisioning }: { provisioning: CoderProvisioning | null }) {
  // Building the workspace is what makes the worktree, so the panel names the
  // work instead of saying there is nothing yet.
  if (provisioning) {
    const copy = PROVISIONING_STEP_COPY[provisioning.step];
    return (
      <div role="status" className="flex flex-col items-center gap-1.5 px-4 py-10 text-center">
        <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
        <p className="text-xs font-medium">{copy.label}</p>
        <p className="text-muted-foreground text-xs">{copy.detail}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-1.5 px-4 py-10 text-center">
      <GitBranch className="text-muted-foreground/50 h-5 w-5" />
      <p className="text-xs font-medium">No worktree yet</p>
      <p className="text-muted-foreground text-xs">
        It appears after this chat&apos;s first message.
      </p>
    </div>
  );
}

/**
 * The right-hand panel: what changed, what is in the worktree, and where the
 * branch stands.
 *
 * A chat that has not sent its first message has no worktree yet, so the panel
 * says that instead of rendering a browser over the wrong directory.
 *
 * Above the tabs, because a failed setup script is about the checkout itself and
 * not about one view of it: an install that broke matters as much in Files as in
 * Terminal, and a warning that only lives in one tab is a warning nobody reads.
 *
 * The terminal keeps running while another tab is open, so it is mounted
 * alongside the tab contents instead of inside one. The ports list pauses its
 * polling with the tab and picks up again when it comes back.
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
  const terminalRunRef = useRef<(command: string) => void>(() => {});
  // Lifted out of the tab, because the badge has to light while another tab is
  // open. The poll slows down when Ports is not the visible one.
  const ports = usePorts(sessionId, tab === "ports");

  return (
    <GlassPanel className="flex h-full min-w-0 flex-col overflow-hidden">
      <SetupFailureNotice failure={state?.setupFailure ?? null} />

      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-0">
        {/* A container query, because the panel is 280px on a phone sheet and
            720px when dragged wide; the icons only earn their room when it is. */}
        <PageTabStrip className="@container border-b px-2 py-1.5">
          <TabsList className="h-auto flex-wrap">
            <TabsTrigger value="changes" className="gap-1.5 text-xs">
              <GitBranch className="hidden h-3.5 w-3.5 @min-[390px]:block" />
              Project
              {state?.changes.length ? (
                <span className="text-muted-foreground font-mono text-[10px]">
                  {state.changes.length}
                </span>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="files" className="gap-1.5 text-xs">
              <FolderTree className="hidden h-3.5 w-3.5 @min-[390px]:block" />
              Files
            </TabsTrigger>
            <TabsTrigger value="terminal" className="gap-1.5 text-xs">
              <SquareTerminal className="hidden h-3.5 w-3.5 @min-[390px]:block" />
              Terminal
            </TabsTrigger>
            <TabsTrigger value="ports" className="gap-1.5 text-xs">
              <Globe className="hidden h-3.5 w-3.5 @min-[390px]:block" />
              Ports
              {ports.data?.ports.length ? (
                <span
                  aria-label={`${ports.data.ports.length} listening`}
                  className="bg-primary inline-block size-1.5 rounded-full"
                />
              ) : null}
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
            <NoWorktree provisioning={state?.provisioning ?? null} />
          ) : (
            <ChangesView
              sessionId={sessionId}
              state={state}
              onRefresh={onRefresh}
              refreshing={refreshing}
              onRunScript={(command) => {
                terminalRunRef.current(command);
                setTab("terminal");
              }}
            />
          )}
        </TabsContent>

        <TabsContent value="files" className="min-h-0 flex-1 overflow-hidden">
          {state?.worktree ? (
            <FileBrowser target="user" rootPath={state.worktree.path} dense />
          ) : (
            <NoWorktree provisioning={state?.provisioning ?? null} />
          )}
        </TabsContent>

        <div
          className={
            tab === "ports"
              ? "flex min-h-0 flex-1 flex-col overflow-hidden"
              : "hidden min-h-0 flex-1 flex-col overflow-hidden"
          }
        >
          <PortsView view={ports} />
        </div>

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
            registerRun={(run) => {
              terminalRunRef.current = run;
            }}
          />
        </div>
      </Tabs>
    </GlassPanel>
  );
}
