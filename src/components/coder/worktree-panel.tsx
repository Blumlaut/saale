"use client";

import { useRef, useState } from "react";
import {
  Download,
  FileText,
  FolderTree,
  GitBranch,
  Globe,
  GitCommitHorizontal,
  Loader2,
  SquareTerminal,
  X,
} from "lucide-react";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FileBrowser } from "@/components/files/file-browser";
import { FileView } from "@/components/files/file-view";
import { PageTabStrip } from "@/components/layout/page";
import { downloadFile } from "@/lib/download";
import { relativeToRoot } from "@/lib/files/paths";
import { rawFileUrl } from "@/lib/files/urls";
import type { FileEntry } from "@/lib/files/types";
import { ChangesView } from "./changes-view";
import { CommitDiffView } from "./commit-diff-view";
import { PortsView } from "./ports-view";
import { PROVISIONING_STEP_COPY } from "./provisioning-copy";
import { SetupFailureNotice } from "./setup-failure-notice";
import { TerminalView } from "./terminal-view";
import type { CoderCommit, CoderProvisioning, CoderSessionState } from "./use-coder-data";
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
 * The close control inside a tab. A span, because the trigger is the button and
 * a button in a button is invalid HTML.
 */
function CloseTab({ label, onClose }: { label: string; onClose: () => void }) {
  return (
    <span
      role="button"
      aria-label={label}
      tabIndex={0}
      onClick={(event) => {
        event.stopPropagation();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.stopPropagation();
          onClose();
        }
      }}
      className="hover:bg-accent focus-visible:outline-ring -mr-1 rounded p-0.5 focus-visible:outline-1"
    >
      <X className="h-3 w-3" />
    </span>
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
 *
 * A file opens as a tab here: the panel is the only surface the user can widen,
 * and an editor needs the room.
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
  // A tab that has been opened keeps its state: leaving the terminal alone
  // must not fold every commit the user just unfolded.
  const [openedTabs, setOpenedTabs] = useState<string[]>(["changes"]);
  // The commit and file the Diff tab shows, or null for no tab at all.
  const [diffTarget, setDiffTarget] = useState<{ commit: CoderCommit; path: string } | null>(null);
  // The file the File tab shows. One at a time: the panel is a side column, and
  // a strip of open files would eat the width the editor needs.
  const [fileTarget, setFileTarget] = useState<FileEntry | null>(null);

  const openTab = (next: string) => {
    setTab(next);
    setOpenedTabs((current) => (current.includes(next) ? current : [...current, next]));
  };

  // Closing the tab from inside it would strand the panel on a value that
  // has no content, so the previous tab comes back first.
  const closeDiffTab = () => {
    if (tab === "diff") openTab("changes");
    setDiffTarget(null);
  };
  const closeFileTab = () => {
    if (tab === "file") openTab("files");
    setFileTarget(null);
  };
  const terminalRunRef = useRef<(command: string) => void>(() => {});
  // Lifted out of the tab, because the badge has to light while another tab is
  // open. The poll slows down when Ports is not the visible one.
  const ports = usePorts(sessionId, tab === "ports");

  return (
    <GlassPanel className="flex h-full min-w-0 flex-col overflow-hidden">
      <SetupFailureNotice failure={state?.setupFailure ?? null} />

      <Tabs value={tab} onValueChange={openTab} className="flex min-h-0 flex-1 flex-col gap-0">
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
            {diffTarget && (
              <TabsTrigger value="diff" className="gap-1.5 text-xs">
                <GitCommitHorizontal className="hidden h-3.5 w-3.5 @min-[390px]:block" />
                Diff
                <CloseTab label="Close the diff tab" onClose={closeDiffTab} />
              </TabsTrigger>
            )}
            {fileTarget && (
              <TabsTrigger value="file" className="gap-1.5 text-xs">
                <FileText className="hidden h-3.5 w-3.5 @min-[390px]:block" />
                <span className="max-w-24 truncate">{fileTarget.name}</span>
                <CloseTab label="Close the file tab" onClose={closeFileTab} />
              </TabsTrigger>
            )}
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

        <TabsContent
          value="changes"
          keepMounted={openedTabs.includes("changes")}
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
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
                openTab("terminal");
              }}
              activeCommitSha={diffTarget?.commit.sha ?? null}
              onOpenCommitFile={(commit, path) => {
                setDiffTarget({ commit, path });
                openTab("diff");
              }}
            />
          )}
        </TabsContent>

        <TabsContent
          value="files"
          keepMounted={openedTabs.includes("files")}
          className="min-h-0 flex-1 overflow-hidden"
        >
          {state?.worktree ? (
            <FileBrowser
              target="user"
              rootPath={state.worktree.path}
              dense
              onOpenFile={(entry) => {
                setFileTarget(entry);
                openTab("file");
              }}
            />
          ) : (
            <NoWorktree provisioning={state?.provisioning ?? null} />
          )}
        </TabsContent>

        {fileTarget && (
          <TabsContent
            value="file"
            keepMounted={openedTabs.includes("file")}
            className="min-h-0 flex-1 overflow-hidden"
          >
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex shrink-0 items-center gap-1.5 border-b px-3 py-2">
                <p
                  className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[11px]"
                  title={fileTarget.path}
                >
                  {relativeToRoot(state?.worktree?.path ?? "", fileTarget.path) ?? fileTarget.path}
                </p>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Download ${fileTarget.name}`}
                  className="h-6 w-6 shrink-0"
                  onClick={() => void downloadFile(rawFileUrl("user", fileTarget.path, true))}
                >
                  <Download className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="flex min-h-0 flex-1 flex-col p-2">
                <FileView target="user" entry={fileTarget} />
              </div>
            </div>
          </TabsContent>
        )}

        {diffTarget && (
          <TabsContent
            value="diff"
            keepMounted={openedTabs.includes("diff")}
            className="min-h-0 flex-1 overflow-hidden"
          >
            <CommitDiffView
              sessionId={sessionId}
              commit={diffTarget.commit}
              initialPath={diffTarget.path}
              onClose={closeDiffTab}
            />
          </TabsContent>
        )}

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
