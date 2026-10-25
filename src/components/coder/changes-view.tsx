"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Check, ChevronDown, GitBranch, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { fetchJson } from "@/lib/http";
import { formatRelativeDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CommitFileList, CommitFilesStatus, splitPath, useCommitFiles } from "./commit-files";
import type { CoderChange, CoderCommit, CoderSessionState } from "./use-coder-data";

/** One diff line's tint. */
function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-muted-foreground";
  if (line.startsWith("@@")) return "bg-muted/60 text-muted-foreground";
  if (line.startsWith("+")) return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (line.startsWith("-")) return "bg-red-500/10 text-red-700 dark:text-red-300";
  return "";
}

/** The file row above the diff already names the file, so the header lines are noise. */
function diffBody(diff: string): string {
  const lines = diff.replace(/\n$/, "").split("\n");
  let start = 0;
  while (start < lines.length && !/^(--- |\+\+\+ |@@)/.test(lines[start] ?? "")) start += 1;
  return lines.slice(start).join("\n");
}

/** A unified diff in a box of its own, so a long line scrolls here. */
export function DiffView({ diff }: { diff: string }) {
  const body = diffBody(diff);
  if (!body.trim()) {
    return <p className="text-muted-foreground px-3 py-2 text-xs">No changes in this file.</p>;
  }

  return (
    <div className="bg-muted/40 mx-2 mb-2 max-h-80 overflow-auto rounded-lg font-mono text-[11px] leading-relaxed">
      {body.split("\n").map((line, index) => (
        <div key={index} className={cn("px-2 whitespace-pre", lineClass(line))}>
          {line || " "}
        </div>
      ))}
    </div>
  );
}

/** The status letter a git user reads in half a second. */
function statusLetter(change: CoderChange): { letter: string; className: string } {
  if (change.untracked) return { letter: "A", className: "text-emerald-600 dark:text-emerald-400" };
  if (change.originalPath) return { letter: "R", className: "text-sky-600 dark:text-sky-400" };
  return { letter: "M", className: "text-amber-600 dark:text-amber-400" };
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

/**
 * A foldable area of the panel: a header row that collapses its content, with
 * the counts on the right where the eye lands before the fold.
 */
function CollapsibleSection({
  label,
  right,
  children,
  defaultOpen = true,
}: {
  label: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b">
      <CollapsibleTrigger className="group hover:bg-accent/40 flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors">
        <ChevronDown className="text-muted-foreground h-3 w-3 shrink-0 -rotate-90 transition-transform group-data-[panel-open]:rotate-0" />
        <span className="console-label flex-1">{label}</span>
        {right}
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

/**
 * One commit: a row that unfolds its file list, and rows that open a file's
 * diff in the Diff tab.
 *
 * The files load on the first unfold, because ten commits' file lists is a
 * lot of git for a list the user may not open.
 */
function CommitRow({
  sessionId,
  commit,
  active,
  onOpenFile,
}: {
  sessionId: string;
  commit: CoderCommit;
  active: boolean;
  onOpenFile: (commit: CoderCommit, path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { files, error, loading } = useCommitFiles(sessionId, commit.sha, open);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={cn(
          "group hover:bg-accent/60 flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors",
          active && "bg-accent",
        )}
        title={commit.sha}
      >
        <ChevronDown
          className={cn(
            "text-muted-foreground mt-0.5 h-3 w-3 shrink-0 transition-transform",
            !open && "-rotate-90",
          )}
        />
        <span className="text-muted-foreground shrink-0 pt-px font-mono text-[11px]">
          {commit.shortSha}
        </span>
        <span className="min-w-0 flex-1 text-xs break-words">{commit.subject}</span>
        <span className="text-muted-foreground shrink-0 pt-px font-mono text-[11px]">
          {formatRelativeDate(commit.date)}
        </span>
      </button>
      {open && (
        <div className="border-b">
          <CommitFilesStatus loading={loading} error={error} />
          {files && (
            <CommitFileList
              files={files}
              indented
              onSelect={(file) => onOpenFile(commit, file.path)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function CommitList({
  sessionId,
  commits,
  activeSha,
  onOpenFile,
}: {
  sessionId: string;
  commits: CoderCommit[];
  activeSha: string | null;
  onOpenFile: (commit: CoderCommit, path: string) => void;
}) {
  if (commits.length === 0) {
    return (
      <p className="text-muted-foreground px-3 py-2 text-xs">No commits on this branch yet.</p>
    );
  }
  return (
    <div className="flex flex-col">
      {commits.slice(0, 10).map((commit) => (
        <CommitRow
          key={commit.sha}
          sessionId={sessionId}
          commit={commit}
          active={activeSha === commit.sha}
          onOpenFile={onOpenFile}
        />
      ))}
    </div>
  );
}

/**
 * The Project tab: which repo and branch this is, where the branch stands,
 * what changed with line counts, the diff of whichever file is open, and the
 * branch's recent commits.
 *
 * The areas fold independently, because a panel that always lists everything
 * gives the same screen whether or not any area has news.
 */
export function ChangesView({
  sessionId,
  state,
  onRefresh,
  refreshing,
  onRunScript,
  activeCommitSha,
  onOpenCommitFile,
}: {
  sessionId: string;
  state: CoderSessionState;
  onRefresh: () => void;
  refreshing: boolean;
  onRunScript?: (name: string) => void;
  /** The commit the Diff tab is showing, if one. */
  activeCommitSha: string | null;
  onOpenCommitFile: (commit: CoderCommit, path: string) => void;
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

  const totals = state.changes.reduce(
    (acc, change) => ({
      added: acc.added + (change.added ?? 0),
      deleted: acc.deleted + (change.deleted ?? 0),
    }),
    { added: 0, deleted: 0 },
  );

  return (
    <div className="flex min-h-0 flex-col">
      <div className="shrink-0 border-b px-3 pt-2.5 pb-2">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={state.project?.slug}>
            {state.project?.name ?? "—"}
          </span>
          {/* The same checkout as every other chat of the project, which is
              worth saying before someone commits on a shared branch. */}
          {state.worktree?.mode === "repo" && (
            <span className="text-muted-foreground shrink-0 font-mono text-[10px] tracking-wide uppercase">
              shared
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
        <div className="mt-1.5 flex items-center gap-2" title={state.upstream || undefined}>
          <GitBranch className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 font-mono text-xs break-all">{state.branch || "—"}</span>
          {state.upstream && (
            <span className="text-muted-foreground hidden shrink-0 font-mono text-[11px] min-[420px]:block">
              {state.upstream}
            </span>
          )}
          {(state.ahead > 0 || state.behind > 0) && (
            <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px]">
              {state.ahead > 0 && <span className="text-muted-foreground">↑{state.ahead}</span>}
              {state.behind > 0 && (
                <span className="text-amber-600 dark:text-amber-400">↓{state.behind}</span>
              )}
            </span>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <CollapsibleSection
          label={state.changes.length === 1 ? "1 file" : `${state.changes.length} files`}
          right={
            <span className="shrink-0 font-mono text-[11px]">
              <span className="text-emerald-600 dark:text-emerald-400">+{totals.added}</span>{" "}
              <span className="text-red-600 dark:text-red-400">−{totals.deleted}</span>
            </span>
          }
        >
          {state.changes.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-3">
              <Check className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
              <span className="text-muted-foreground text-xs">
                Worktree clean. All changes are committed.
              </span>
            </div>
          ) : (
            state.changes.map((change) => {
              const { dir, name } = splitPath(change.path);
              const status = statusLetter(change);
              const open = openPath === change.path;
              return (
                <div key={change.path}>
                  <button
                    type="button"
                    onClick={() => void openDiff(change)}
                    className={cn(
                      "hover:bg-accent/60 flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors",
                      open && "bg-accent",
                    )}
                    title={
                      change.originalPath ? `${change.originalPath} → ${change.path}` : change.path
                    }
                  >
                    <span
                      className={cn(
                        "w-3 shrink-0 text-center font-mono text-[11px] font-semibold",
                        status.className,
                      )}
                    >
                      {status.letter}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs">{name}</span>
                      <span className="text-muted-foreground block truncate font-mono text-[10px]">
                        {dir}
                        {change.staged ? " · staged" : ""}
                      </span>
                    </span>
                    <Counts change={change} />
                  </button>
                  {open && (
                    <div className="border-b">
                      {loadingDiff && (
                        <div className="flex items-center gap-2 px-3 py-2">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          <span className="text-muted-foreground text-xs">Reading diff…</span>
                        </div>
                      )}
                      {diffError && (
                        <p className="text-destructive px-3 py-2 text-xs break-words">
                          {diffError}
                        </p>
                      )}
                      {diff !== null && <DiffView diff={diff} />}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </CollapsibleSection>

        {state.scripts.length > 0 && (
          <CollapsibleSection
            label="Scripts"
            right={
              <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
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
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{script.name}</span>
                  <span className="text-muted-foreground min-w-0 truncate font-mono text-[10px]">
                    npm run {script.name}
                  </span>
                </button>
              ))}
            </div>
          </CollapsibleSection>
        )}

        <CollapsibleSection
          label="Recent commits"
          right={
            <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
              {state.commits.length}
            </span>
          }
        >
          <CommitList
            sessionId={sessionId}
            commits={state.commits}
            activeSha={activeCommitSha}
            onOpenFile={onOpenCommitFile}
          />
        </CollapsibleSection>
      </div>
    </div>
  );
}
