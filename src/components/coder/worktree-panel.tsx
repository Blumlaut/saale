"use client";

import { useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  FolderTree,
  GitBranch,
  Globe,
  GitCommitHorizontal,
  Loader2,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { GlassPanel } from "@/components/ui/glass-panel";
import { FileBrowser } from "@/components/files/file-browser";
import { CloseTab, useFileTab } from "@/components/session/file-tab";
import { SessionPanel, type SessionPanelTab } from "@/components/session/session-panel";
import { oneOf, usePersistedState } from "@/hooks/use-persisted-state";
import { ChangesView } from "./changes-view";
import { CommitDiffView } from "./commit-diff-view";
import { PortsView } from "./ports-view";
import { PROVISIONING_STEP_COPY } from "./provisioning-copy";
import { SetupFailureNotice } from "./setup-failure-notice";
import type {
  CoderCommit,
  CoderProvisioning,
  CoderPullRequest,
  CoderSessionState,
} from "./use-coder-data";
import { usePorts } from "./use-ports";

/** xterm is a large library, and the panel is often read without a terminal open. */
const TerminalView = dynamic(() => import("./terminal-view").then((m) => m.TerminalView), {
  ssr: false,
});

/** The panel while the chat is on its way out: there is no checkout to read. */
function ClosingChat({ gone }: { gone: boolean }) {
  return (
    <div
      role="status"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-4 py-10 text-center"
    >
      {gone ? (
        <Trash2 className="text-muted-foreground/50 h-5 w-5" />
      ) : (
        <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
      )}
      <p className="text-xs font-medium">{gone ? "This chat was deleted" : "Deleting this chat"}</p>
      <p className="text-muted-foreground text-xs">
        {gone
          ? "Its worktree and branch are gone with it."
          : "Its worktree and branch are being removed."}
      </p>
    </div>
  );
}

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
 * The coder chat's panel: what changed, what is in the worktree, and where the
 * branch stands.
 *
 * The panel itself is `SessionPanel`, the same one a plain chat shows; this
 * fills it with the worktree's tabs. A chat that has not sent its first message
 * has no worktree yet, so the tabs say that instead of rendering a browser over
 * the wrong directory.
 *
 * Above the tabs, because a failed setup script is about the checkout itself and
 * not about one view of it: an install that broke matters as much in Files as in
 * Terminal, and a warning that only lives in one tab is a warning nobody reads.
 *
 * The terminal keeps running while another tab is open, which is what
 * `SessionPanel` promises every tab.
 */
export function WorktreePanel({
  sessionId,
  state,
  loading,
  error,
  gone,
  onRefresh,
  refreshing,
  pullRequest,
  onLoadMoreCommits,
  loadingMoreCommits,
}: {
  sessionId: string;
  state: CoderSessionState | null;
  loading: boolean;
  error: string | null;
  /** The server no longer has this chat: it was deleted. */
  gone: boolean;
  onRefresh: () => void;
  refreshing: boolean;
  pullRequest: CoderPullRequest | null;
  onLoadMoreCommits: () => void;
  loadingMoreCommits: boolean;
}) {
  // Diff and File hold a target, so only a plain tab is remembered here.
  const [tab, setTab] = usePersistedState<string>("coder:panelTab", "changes", {
    validate: oneOf("changes", "files", "terminal", "ports"),
  });
  // The commit the Diff tab shows, or null for no tab at all.
  const [diffTarget, setDiffTarget] = useState<{ commit: CoderCommit; path: string } | null>(null);
  const files = useFileTab({
    target: "user",
    rootPath: state?.worktree?.path ?? "",
    onClose: () => {
      if (tab === "file") setTab("files");
    },
  });

  // Closing the tab from inside it would strand the panel on a value that has
  // no content, so the previous tab comes back first.
  const closeDiffTab = () => {
    if (tab === "diff") setTab("changes");
    setDiffTarget(null);
  };

  const terminalRunRef = useRef<(command: string) => void>(() => {});
  // A command asked for before the terminal has been opened waits for it.
  const pendingTerminalRun = useRef<string | null>(null);
  // Lifted out of the tab, because the badge has to light while another tab is
  // open. The poll slows down when Ports is not the visible one.
  const closing = gone || state?.deleting === true;
  const ports = usePorts(closing ? null : sessionId, tab === "ports");

  // The panel keeps the terminal mounted once visited, so its shell survives a
  // tab switch; the first command waits for the mount.
  const launchInTerminal = (command: string) => {
    if (terminalRunRef.current) terminalRunRef.current(command);
    else pendingTerminalRun.current = command;
    setTab("terminal");
  };

  // The chat is on its way out: its checkout is already gone, so the panel says
  // what is happening instead of asking git about it.
  if (closing) {
    return (
      <GlassPanel className="flex h-full min-w-0 flex-col overflow-hidden">
        <ClosingChat gone={gone} />
      </GlassPanel>
    );
  }

  const tabs: SessionPanelTab[] = [
    {
      id: "changes",
      label: "Project",
      icon: <GitBranch className="h-3.5 w-3.5" />,
      ...(state?.changes.length
        ? {
            badge: (
              <span className="text-muted-foreground text-[10px] tabular-nums">
                {state.changes.length}
              </span>
            ),
          }
        : {}),
      content:
        loading && !state ? (
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
              launchInTerminal(command);
            }}
            activeCommitSha={diffTarget?.commit.sha ?? null}
            onOpenCommitFile={(commit, path) => {
              setDiffTarget({ commit, path });
              setTab("diff");
            }}
            pullRequest={pullRequest}
            onLoadMoreCommits={onLoadMoreCommits}
            loadingMoreCommits={loadingMoreCommits}
          />
        ),
    },
    {
      id: "files",
      label: "Files",
      icon: <FolderTree className="h-3.5 w-3.5" />,
      content: state?.worktree ? (
        <FileBrowser
          target="user"
          rootPath={state.worktree.path}
          dense
          onOpenFile={(entry) => {
            files.open(entry);
            setTab("file");
          }}
        />
      ) : (
        <NoWorktree provisioning={state?.provisioning ?? null} />
      ),
    },
    ...(diffTarget
      ? [
          {
            id: "diff",
            label: "Diff",
            icon: <GitCommitHorizontal className="h-3.5 w-3.5" />,
            trailing: <CloseTab label="Close the diff tab" onClose={closeDiffTab} />,
            content: (
              <CommitDiffView
                sessionId={sessionId}
                commit={diffTarget.commit}
                initialPath={diffTarget.path}
                onClose={closeDiffTab}
              />
            ),
          },
        ]
      : []),
    ...(files.tab ? [files.tab] : []),
    {
      id: "terminal",
      label: "Terminal",
      icon: <SquareTerminal className="h-3.5 w-3.5" />,
      content: (
        <TerminalView
          sessionId={sessionId}
          worktree={
            state?.worktree ? { path: state.worktree.path, branch: state.worktree.branch } : null
          }
          registerRun={(run) => {
            terminalRunRef.current = run;
            if (pendingTerminalRun.current !== null) {
              run(pendingTerminalRun.current);
              pendingTerminalRun.current = null;
            }
          }}
        />
      ),
    },
    {
      id: "ports",
      label: "Ports",
      icon: <Globe className="h-3.5 w-3.5" />,
      ...(ports.data?.ports.length
        ? {
            badge: (
              <span
                aria-label={`${ports.data.ports.length} listening`}
                className="bg-primary inline-block size-1.5 rounded-full"
              />
            ),
          }
        : {}),
      content: <PortsView view={ports} />,
    },
  ];

  return (
    <SessionPanel
      value={tab}
      onValueChange={setTab}
      tabs={tabs}
      notice={<SetupFailureNotice failure={state?.setupFailure ?? null} />}
    />
  );
}
