"use client";

import { useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  Copy,
  ExternalLink,
  GitCommitHorizontal,
  Loader2,
  MoreVertical,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { commitWebUrl, remoteHostName } from "@/lib/coder/remote-url";
import { formatRelativeDate } from "@/lib/format";
import { cn, ROW_ACTION } from "@/lib/utils";
import { CommitFileList, useCommitFiles } from "./commit-files";
import type { CoderCommit } from "./use-coder-data";

/** Copy a commit's full sha, which is the one thing a right-click is wanted for. */
async function copySha(sha: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(sha);
    toast.success("Commit SHA copied");
  } catch (err) {
    console.error("Failed to copy the commit SHA:", err);
    toast.error("Could not copy the SHA");
  }
}

/**
 * One commit: a row that unfolds its file list, and rows that open a file's
 * diff in the Diff tab.
 *
 * The files load on the first unfold, because ten commits' file lists is a lot
 * of git for a list the user may not open.
 */
function CommitRow({
  sessionId,
  commit,
  active,
  remoteUrl,
  onOpenFile,
}: {
  sessionId: string;
  commit: CoderCommit;
  active: boolean;
  /** The repo's web address, for the commit link; null when it has none. */
  remoteUrl: string | null;
  onOpenFile: (commit: CoderCommit, path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { files, error, loading } = useCommitFiles(sessionId, commit.sha, open);
  const commitUrl = remoteUrl ? commitWebUrl(remoteUrl, commit.sha) : null;
  const hostName = remoteUrl ? remoteHostName(remoteUrl) : null;

  return (
    <div className="group">
      <div
        className={cn(
          "hover:bg-accent/60 flex items-center gap-1 pr-1 transition-colors",
          active && "bg-accent",
        )}
      >
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-start gap-2 py-1.5 pl-3 text-left"
          title={commit.refs.length > 0 ? commit.refs.join(", ") : commit.sha}
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
          <span className="min-w-0 flex-1 text-xs break-words">
            {commit.pushed === false && (
              <ArrowUp
                aria-label="Not pushed"
                className="-mt-0.5 mr-1 inline h-3 w-3 text-amber-600 dark:text-amber-400"
              />
            )}
            {commit.subject}
          </span>
          <span className="text-muted-foreground shrink-0 pt-px text-[11px] tabular-nums">
            {formatRelativeDate(commit.date)}
          </span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Commit ${commit.shortSha} actions`}
                className={cn("shrink-0", ROW_ACTION)}
              />
            }
          >
            <MoreVertical className="h-3 w-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuItem onClick={() => void copySha(commit.sha)}>
              <Copy className="h-3.5 w-3.5" />
              Copy SHA
            </DropdownMenuItem>
            {commitUrl ? (
              <DropdownMenuItem render={<a href={commitUrl} target="_blank" rel="noreferrer" />}>
                <ExternalLink className="h-3.5 w-3.5" />
                Open in {hostName ?? "the remote"}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {open && (
        <div className="border-t">
          {loading && (
            <div className="flex items-center gap-2 px-3 py-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span className="text-muted-foreground text-xs">Reading files…</span>
            </div>
          )}
          {error && <p className="text-destructive px-3 py-2 text-xs break-words">{error}</p>}
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

/**
 * The branch's history, newest first.
 *
 * `upstream` marks the line every commit above it crossed: a commit above the
 * line exists only in this checkout, which is what "local" means and what the
 * ← arrow on the row says in words for a screen reader.
 */
export function CommitList({
  sessionId,
  commits,
  upstream,
  remoteUrl,
  activeSha,
  truncated,
  loadingMore,
  onLoadMore,
  onOpenFile,
}: {
  sessionId: string;
  commits: CoderCommit[];
  /** The branch's upstream, "" when it has none. */
  upstream: string;
  remoteUrl: string | null;
  activeSha: string | null;
  /** True when the branch has older commits than the ones listed. */
  truncated: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onOpenFile: (commit: CoderCommit, path: string) => void;
}) {
  if (commits.length === 0) {
    return (
      <p className="text-muted-foreground px-3 py-2 text-xs">No commits on this branch yet.</p>
    );
  }

  return (
    <div className="flex flex-col">
      {commits.map((commit, index) => {
        const previous = commits[index - 1];
        // The first commit the upstream also has closes the local run above it.
        const crossesToRemote =
          upstream !== "" && previous?.pushed === false && commit.pushed === true;
        return (
          <div key={commit.sha}>
            {crossesToRemote && (
              <div className="flex items-center gap-2 px-3 py-1">
                <span className="bg-border h-px flex-1" />
                <span className="console-label shrink-0">{upstream}</span>
                <span className="bg-border h-px flex-1" />
              </div>
            )}
            <CommitRow
              sessionId={sessionId}
              commit={commit}
              active={activeSha === commit.sha}
              remoteUrl={remoteUrl}
              onOpenFile={onOpenFile}
            />
          </div>
        );
      })}

      {truncated && (
        <Button
          variant="ghost"
          size="xs"
          onClick={onLoadMore}
          disabled={loadingMore}
          className="text-muted-foreground mx-2 my-1.5 gap-1.5 self-center"
        >
          {loadingMore ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <GitCommitHorizontal className="h-3 w-3" />
          )}
          Load older commits
        </Button>
      )}
    </div>
  );
}

/** The section header's own count: how many of the listed commits are local. */
export function localCommitCount(commits: CoderCommit[]): number {
  return commits.filter((commit) => commit.pushed === false).length;
}
