"use client";

import { useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  CloudDownload,
  ExternalLink,
  GitBranch,
  GitBranchPlus,
  GitPullRequest,
  GitPullRequestCreate,
  GitPullRequestDraft,
  Loader2,
  MoreVertical,
  RefreshCw,
  Undo2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { remoteHostName, repoWebUrl } from "@/lib/coder/remote-url";
import { postJson } from "@/lib/http";
import { cn } from "@/lib/utils";
import { NewBranchDialog } from "./branch-dialog";
import { useBranches, type CoderPullRequest, type CoderSessionState } from "./use-coder-data";
import type { useGitActions } from "./use-git-actions";

/** The colour a check rollup earns, in token pairs that read in both modes. */
function checksTone(checks: CoderPullRequest["checks"]): string {
  if (!checks) return "text-muted-foreground";
  if (checks.failed > 0) return "text-red-600 dark:text-red-400";
  if (checks.pending > 0) return "text-amber-600 dark:text-amber-400";
  return "text-emerald-600 dark:text-emerald-400";
}

/** The pull request on this branch: a link, because its page is the next stop. */
function PullRequestBadge({ pullRequest }: { pullRequest: CoderPullRequest }) {
  const Icon = pullRequest.draft ? GitPullRequestDraft : GitPullRequest;
  return (
    <a
      href={pullRequest.url}
      target="_blank"
      rel="noreferrer"
      title={`${pullRequest.title} · ${pullRequest.state.toLowerCase()}`}
      className={cn(
        "hover:bg-accent inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[10px] tabular-nums transition-colors",
        checksTone(pullRequest.checks),
      )}
    >
      <Icon className="h-3 w-3" />#{pullRequest.number}
    </a>
  );
}

/**
 * The branch this checkout is on, where it stands, and the ways to move it.
 *
 * Fetch, pull and push are three buttons rather than one "sync": they are three
 * different decisions, and only one of them can lose work.
 */
export function SyncRow({
  sessionId,
  state,
  actions,
  pullRequest,
  onRefresh,
}: {
  sessionId: string;
  state: CoderSessionState;
  actions: ReturnType<typeof useGitActions>;
  pullRequest: CoderPullRequest | null;
  onRefresh: () => void;
}) {
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [newBranchOpen, setNewBranchOpen] = useState(false);
  const [creatingPr, setCreatingPr] = useState(false);
  const branches = useBranches(sessionId, branchMenuOpen);

  const hasRemote = state.remotes.length > 0;
  const origin = state.remotes.find((remote) => remote.name === "origin") ?? state.remotes[0];
  const remotePage = origin ? repoWebUrl(origin.url) : null;
  const remoteName = origin ? remoteHostName(origin.url) : null;
  const hasUpstream = state.upstream !== "";
  const dirty = state.changes.length > 0;

  const createPullRequest = async (draft: boolean) => {
    setCreatingPr(true);
    try {
      const body = await postJson<{ pullRequest: CoderPullRequest }>(
        `/api/coder/sessions/${encodeURIComponent(sessionId)}/pull-request`,
        { draft },
      );
      toast.success("Pull request opened", { description: body.pullRequest.url || undefined });
      onRefresh();
    } catch (err) {
      console.error(`Failed to open a pull request for ${sessionId}:`, err);
      toast.error("Could not open a pull request", {
        description: err instanceof Error ? err.message.slice(0, 300) : undefined,
      });
    } finally {
      setCreatingPr(false);
    }
  };

  const switchTo = async (name: string) => {
    setBranchMenuOpen(false);
    if (name === state.branch) return;
    await actions.run({ action: "branch", name }, `Switched to ${name}`);
  };

  return (
    <div className="shrink-0 space-y-1 border-b px-3 py-2">
      <div className="flex items-center gap-1">
        <DropdownMenu open={branchMenuOpen} onOpenChange={setBranchMenuOpen}>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                className="min-w-0 gap-1 px-1.5 font-mono text-[11px]"
                aria-label="Branches"
                title={
                  state.upstream ? `Tracking ${state.upstream}` : "This branch has no upstream"
                }
                disabled={actions.busy}
              />
            }
          >
            <GitBranch className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 truncate">{state.branch || "—"}</span>
            <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 min-w-52 overflow-y-auto">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Switch branch</DropdownMenuLabel>
              {branches.loading && (
                <div className="flex items-center gap-2 px-2 py-1.5">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span className="text-muted-foreground text-xs">Reading branches…</span>
                </div>
              )}
              {branches.error && (
                <p className="text-destructive px-2 py-1.5 text-xs break-words">{branches.error}</p>
              )}
              {branches.branches.map((branch) => (
                <DropdownMenuItem
                  key={branch.name}
                  onClick={() => void switchTo(branch.name)}
                  disabled={branch.current}
                  className="font-mono text-xs"
                >
                  <GitBranch className="h-3.5 w-3.5" />
                  <span className="min-w-0 flex-1 truncate">{branch.name}</span>
                  {branch.current && <Check className="h-3.5 w-3.5 shrink-0" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setNewBranchOpen(true)}>
              <GitBranchPlus className="h-3.5 w-3.5" />
              New branch…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <span className="flex shrink-0 items-center gap-1 text-[11px] tabular-nums">
          {state.ahead > 0 && (
            <span
              className="text-muted-foreground"
              title={`${state.ahead} commit${state.ahead === 1 ? "" : "s"} not pushed`}
            >
              ↑{state.ahead}
            </span>
          )}
          {state.behind > 0 && (
            <span className="text-amber-600 dark:text-amber-400" title={`${state.behind} to pull`}>
              ↓{state.behind}
            </span>
          )}
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Fetch from the remote"
            title={
              hasRemote
                ? "Fetch — ask the remote, change nothing here"
                : "This project has no remote"
            }
            disabled={actions.busy || !hasRemote}
            onClick={() => void actions.run({ action: "fetch" })}
          >
            {actions.isRunning("fetch") ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CloudDownload className="h-3.5 w-3.5" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Pull"
            title={
              hasUpstream
                ? "Pull — fast-forward only"
                : "Push this branch first, then it can be pulled"
            }
            disabled={actions.busy || !hasUpstream}
            onClick={() => void actions.run({ action: "pull" })}
          >
            {actions.isRunning("pull") ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ArrowDownToLine className="h-3.5 w-3.5" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Push"
            title={hasRemote ? "Push this branch" : "This project has no remote"}
            disabled={actions.busy || !hasRemote}
            onClick={() => void actions.run({ action: "push" })}
          >
            {actions.isRunning("push") ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ArrowUpFromLine className="h-3.5 w-3.5" />
            )}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="More git actions"
                  disabled={actions.busy || creatingPr}
                />
              }
            >
              {creatingPr ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <MoreVertical className="h-3.5 w-3.5" />
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-52">
              <DropdownMenuItem onClick={onRefresh}>
                <RefreshCw className="h-3.5 w-3.5" />
                Refresh
              </DropdownMenuItem>
              {hasUpstream && (
                <DropdownMenuItem
                  onClick={() =>
                    void actions.run({ action: "pull", rebase: true }, "Rebased on the remote")
                  }
                >
                  <ArrowDownToLine className="h-3.5 w-3.5" />
                  Pull and rebase
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => void actions.run({ action: "stash" })}
                disabled={!dirty}
              >
                <Archive className="h-3.5 w-3.5" />
                Stash changes
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => void actions.run({ action: "stash-pop" })}
                disabled={state.stashes === 0}
              >
                <ArchiveRestore className="h-3.5 w-3.5" />
                Restore stash
                {state.stashes > 0 && (
                  <span className="text-muted-foreground ml-auto text-[10px] tabular-nums">
                    {state.stashes}
                  </span>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => void actions.run({ action: "undo-commit" })}
                disabled={state.commits.length === 0 || state.head === ""}
              >
                <Undo2 className="h-3.5 w-3.5" />
                Undo last commit
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {pullRequest === null && (
                <>
                  <DropdownMenuItem
                    onClick={() => void createPullRequest(false)}
                    disabled={!hasRemote}
                  >
                    <GitPullRequestCreate className="h-3.5 w-3.5" />
                    Create pull request
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => void createPullRequest(true)}
                    disabled={!hasRemote}
                  >
                    <GitPullRequestDraft className="h-3.5 w-3.5" />
                    Create draft pull request
                  </DropdownMenuItem>
                </>
              )}
              {remotePage && (
                <DropdownMenuItem render={<a href={remotePage} target="_blank" rel="noreferrer" />}>
                  <ExternalLink className="h-3.5 w-3.5" />
                  Open repository in {remoteName ?? "the remote"}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {(hasUpstream || pullRequest) && (
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[10px]"
            title={state.upstream || undefined}
          >
            {hasUpstream ? state.upstream : "no upstream"}
          </span>
          {pullRequest && <PullRequestBadge pullRequest={pullRequest} />}
        </div>
      )}

      <NewBranchDialog
        open={newBranchOpen}
        onOpenChange={setNewBranchOpen}
        onCreate={(name) =>
          actions.run({ action: "branch", name, create: true }, `Created ${name}`)
        }
      />
    </div>
  );
}
