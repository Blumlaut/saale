"use client";

import { useEffect, useState } from "react";
import { FileDiff, GitBranch, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { fetchJson } from "@/lib/http";
import { cn } from "@/lib/utils";
import type { CoderChange, CoderCommit, CoderSessionState } from "./use-coder-data";

/** One diff line's tint. */
function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-muted-foreground";
  if (line.startsWith("@@")) return "bg-muted/60 text-muted-foreground";
  if (line.startsWith("+")) return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (line.startsWith("-")) return "bg-red-500/10 text-red-700 dark:text-red-300";
  return "";
}

/** A unified diff in a box of its own, so a long line scrolls here. */
export function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) {
    return <p className="text-muted-foreground px-3 py-2 text-xs">No changes in this file.</p>;
  }

  return (
    <div className="bg-muted/30 max-h-80 overflow-auto font-mono text-[11px] leading-relaxed">
      {diff
        .replace(/\n$/, "")
        .split("\n")
        .map((line, index) => (
          <div key={index} className={cn("px-2 whitespace-pre", lineClass(line))}>
            {line || " "}
          </div>
        ))}
    </div>
  );
}

/** Where a changed path sits in the index. */
function changeMarker(change: CoderChange): string {
  if (change.untracked) return "new";
  if (change.staged && change.unstaged) return "both";
  if (change.staged) return "staged";
  return "modified";
}

function Counts({ change }: { change: CoderChange }) {
  if (change.added === null && change.deleted === null) return null;
  return (
    <span className="shrink-0 font-mono text-[11px]">
      <span className="text-emerald-600 dark:text-emerald-400">+{change.added ?? 0}</span>{" "}
      <span className="text-red-600 dark:text-red-400">−{change.deleted ?? 0}</span>
    </span>
  );
}

function CommitList({ commits }: { commits: CoderCommit[] }) {
  if (commits.length === 0) {
    return (
      <p className="text-muted-foreground px-3 py-2 text-xs">No commits on this branch yet.</p>
    );
  }
  return (
    <div className="flex flex-col">
      {commits.slice(0, 10).map((commit) => (
        <div key={commit.sha} className="flex items-start gap-2 px-3 py-1.5">
          <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
            {commit.shortSha}
          </span>
          <span className="min-w-0 flex-1 text-xs break-words">{commit.subject}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * The Project tab: branch position, changed files with line counts, the diff of
 * whichever file is open, and the branch's recent commits.
 */
export function ChangesView({
  sessionId,
  state,
  onRefresh,
  refreshing,
}: {
  sessionId: string;
  state: CoderSessionState;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);

  // A refresh can move the file a diff belongs to; drop a diff that is stale.
  useEffect(() => {
    if (!openPath) return;
    if (state.changes.some((change) => change.path === openPath)) return;
    setOpenPath(null);
    setDiff(null);
  }, [state.changes, openPath]);

  const openDiff = async (change: CoderChange) => {
    if (openPath === change.path) {
      setOpenPath(null);
      setDiff(null);
      return;
    }
    setOpenPath(change.path);
    setLoadingDiff(true);
    setDiffError(null);
    setDiff(null);

    const query = new URLSearchParams({ path: change.path });
    // An unstaged change is shown from the index down; a staged one from HEAD.
    if (change.staged && !change.unstaged) query.set("staged", "1");

    try {
      const body = await fetchJson<{ diff: string }>(
        `/api/coder/sessions/${encodeURIComponent(sessionId)}/diff?${query.toString()}`,
      );
      setDiff(body.diff);
    } catch (err) {
      console.error(`Failed to load the diff for ${change.path}:`, err);
      setDiffError(err instanceof Error ? err.message : "Could not read this diff.");
    } finally {
      setLoadingDiff(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <GitBranch className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 font-mono text-xs break-all">{state.branch || "—"}</span>
        {(state.ahead > 0 || state.behind > 0) && (
          <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
            {state.ahead > 0 && `↑${state.ahead}`} {state.behind > 0 && `↓${state.behind}`}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Refresh changes"
          onClick={onRefresh}
          disabled={refreshing}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {state.changes.length === 0 ? (
          <p className="text-muted-foreground px-3 py-2 text-xs">The worktree is clean.</p>
        ) : (
          state.changes.map((change) => (
            <div key={change.path}>
              <button
                type="button"
                onClick={() => void openDiff(change)}
                className={cn(
                  "hover:bg-accent/60 flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors",
                  openPath === change.path && "bg-accent",
                )}
              >
                <FileDiff className="text-muted-foreground mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs break-all">{change.path}</span>
                  <span className="text-muted-foreground block text-[11px]">
                    {changeMarker(change)}
                  </span>
                </span>
                <Counts change={change} />
              </button>
              {openPath === change.path && (
                <div className="border-y">
                  {loadingDiff && (
                    <div className="flex items-center gap-2 px-3 py-2">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span className="text-muted-foreground text-xs">Reading diff…</span>
                    </div>
                  )}
                  {diffError && (
                    <p className="text-destructive px-3 py-2 text-xs break-words">{diffError}</p>
                  )}
                  {diff !== null && <DiffView diff={diff} />}
                </div>
              )}
            </div>
          ))
        )}

        <Separator />
        <p className="console-label px-3 pt-2 pb-1">Recent commits</p>
        <CommitList commits={state.commits} />
      </div>
    </div>
  );
}
