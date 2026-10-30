"use client";

import { useState } from "react";
import { GitCommitHorizontal, RefreshCw, ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChangeList, StashHint } from "./change-list";
import { CollapsibleSection } from "./collapsible-section";
import { CommitDialog } from "./commit-dialog";
import { CommitList, localCommitCount } from "./commit-list";
import { SyncRow } from "./sync-row";
import { useGitActions } from "./use-git-actions";
import type { CoderCommit, CoderPullRequest, CoderSessionState } from "./use-coder-data";

/**
 * The Project tab: which repo and branch this is, where the branch stands,
 * what changed with line counts, the commit box, the scripts worth running and
 * the branch's history.
 *
 * The areas fold independently, because a panel that always lists everything
 * gives the same screen whether or not any area has news.
 */
/** The slim row that opens the commit dialog, and only exists when it can. */
function CommitTrigger({ state, onClick }: { state: CoderSessionState; onClick: () => void }) {
  const staged = state.changes.filter((change) => change.staged).length;
  const changed = state.changes.length;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
      <p className="text-muted-foreground min-w-0 flex-1 truncate text-[11px]">
        {staged > 0
          ? `${staged} staged${changed > staged ? ` · ${changed - staged} more` : ""}`
          : `${changed} file${changed === 1 ? "" : "s"} to commit`}
      </p>
      <Button size="xs" className="h-7 gap-1.5" onClick={onClick}>
        <GitCommitHorizontal className="h-3.5 w-3.5" />
        Commit…
      </Button>
    </div>
  );
}

export function ChangesView({
  sessionId,
  state,
  onRefresh,
  refreshing,
  onRunScript,
  activeCommitSha,
  onOpenCommitFile,
  pullRequest,
  onLoadMoreCommits,
  loadingMoreCommits,
}: {
  sessionId: string;
  state: CoderSessionState;
  onRefresh: () => void;
  refreshing: boolean;
  onRunScript?: (name: string) => void;
  /** The commit the Diff tab is showing, if one. */
  activeCommitSha: string | null;
  onOpenCommitFile: (commit: CoderCommit, path: string) => void;
  pullRequest: CoderPullRequest | null;
  onLoadMoreCommits: () => void;
  loadingMoreCommits: boolean;
}) {
  const actions = useGitActions(sessionId, onRefresh);
  const [commitOpen, setCommitOpen] = useState(false);
  const local = localCommitCount(state.commits);
  const origin = state.remotes.find((remote) => remote.name === "origin") ?? state.remotes[0];
  const remoteUrl = origin?.url ?? null;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 pt-2.5 pb-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={state.project?.slug}>
          {state.project?.name ?? "—"}
        </span>
        {/* The same checkout as every other chat of the project, which is
            worth saying before someone commits on a shared branch. */}
        {state.worktree?.mode === "repo" && (
          <span className="text-muted-foreground shrink-0 text-[10px] tracking-wide uppercase">
            shared
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Refresh the worktree"
          title="Refresh the worktree"
          onClick={onRefresh}
          disabled={refreshing}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <SyncRow
          sessionId={sessionId}
          state={state}
          actions={actions}
          pullRequest={pullRequest}
          onRefresh={onRefresh}
        />

        {state.changes.length > 0 && (
          <CommitTrigger state={state} onClick={() => setCommitOpen(true)} />
        )}
        <CommitDialog
          open={commitOpen}
          onOpenChange={setCommitOpen}
          state={state}
          actions={actions}
        />

        <ChangeList sessionId={sessionId} changes={state.changes} actions={actions} />

        {state.stashes > 0 && <StashHint count={state.stashes} />}

        {state.scripts.length > 0 && (
          <CollapsibleSection
            label="Scripts"
            defaultOpen={false}
            right={
              <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
                {state.scripts.length}
              </span>
            }
          >
            <div className="flex flex-col gap-1 px-3 py-1.5">
              {state.scripts.map((script) => (
                <button
                  key={script.name}
                  type="button"
                  onClick={() => onRunScript?.(script.runCommand)}
                  className="hover:bg-accent/60 flex items-center gap-2 rounded px-2 py-1 text-left transition-colors"
                  title={script.command}
                >
                  <ScrollText className="text-muted-foreground h-3 w-3 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-xs">{script.name}</span>
                  <span className="text-muted-foreground min-w-0 truncate font-mono text-[10px]">
                    {script.runCommand}
                  </span>
                </button>
              ))}
            </div>
          </CollapsibleSection>
        )}

        <CollapsibleSection
          label="History"
          right={
            <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
              {local > 0 ? `${local} local` : state.commits.length}
            </span>
          }
        >
          <CommitList
            sessionId={sessionId}
            commits={state.commits}
            upstream={state.upstream}
            remoteUrl={remoteUrl}
            activeSha={activeCommitSha}
            truncated={state.commitsTruncated}
            loadingMore={loadingMoreCommits}
            onLoadMore={onLoadMoreCommits}
            onOpenFile={onOpenCommitFile}
          />
        </CollapsibleSection>
      </div>
    </div>
  );
}
