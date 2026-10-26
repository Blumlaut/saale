"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { fetchJson } from "@/lib/http";
import { cn } from "@/lib/utils";
import type { CommitDiffFile } from "./use-coder-data";

/** The commit-diff endpoint, with a path to ask for that file's two sides. */
export function commitDiffUrl(sessionId: string, sha: string, path?: string): string {
  const query = new URLSearchParams({ sha });
  if (path) query.set("path", path);
  return `/api/coder/sessions/${encodeURIComponent(sessionId)}/commit-diff?${query.toString()}`;
}

/** The status letter a git user reads in half a second. */
export function statusStyle(status: string): string {
  if (status === "A") return "text-emerald-600 dark:text-emerald-400";
  if (status === "D") return "text-red-600 dark:text-red-400";
  if (status === "R" || status === "C") return "text-sky-600 dark:text-sky-400";
  if (status === "M") return "text-amber-600 dark:text-amber-400";
  return "text-muted-foreground";
}

/** A repo path as a file name over its (muted) folder. */
export function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf("/");
  if (slash === -1) return { dir: "", name: path };
  return { dir: path.slice(0, slash), name: path.slice(slash + 1) };
}

/**
 * The paths a commit touched.
 *
 * `enabled` lets a folded commit row fetch nothing until it is opened.
 */
export function useCommitFiles(sessionId: string, sha: string, enabled = true) {
  const [files, setFiles] = useState<CommitDiffFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchJson<{ files: CommitDiffFile[] }>(commitDiffUrl(sessionId, sha))
      .then((body) => {
        if (!cancelled) setFiles(body.files);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error(`Failed to load the commit diff for ${sha}:`, err);
        setError(err instanceof Error ? err.message : "Could not read this commit.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, sha, enabled]);

  return { files, error, loading };
}

/** One row of a commit's file list. */
export function CommitFileList({
  files,
  activePath = null,
  onSelect,
  indented = false,
}: {
  files: CommitDiffFile[];
  activePath?: string | null;
  onSelect: (file: CommitDiffFile) => void;
  indented?: boolean;
}) {
  if (files.length === 0) {
    return <p className="text-muted-foreground px-3 py-2 text-xs">This commit changes no files.</p>;
  }

  return (
    <div className="flex flex-col">
      {files.map((file) => {
        const { dir, name } = splitPath(file.path);
        return (
          <button
            key={file.path}
            type="button"
            onClick={() => onSelect(file)}
            className={cn(
              "hover:bg-accent/60 flex w-full items-center gap-2 py-1.5 pr-3 text-left transition-colors",
              indented ? "pl-6" : "pl-3",
              activePath === file.path && "bg-accent",
            )}
            title={file.originalPath ? `${file.originalPath} → ${file.path}` : file.path}
          >
            <span
              className={cn(
                "w-3 shrink-0 text-center text-[11px] font-semibold",
                statusStyle(file.status),
              )}
            >
              {file.status}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs">{name}</span>
              <span className="text-muted-foreground block truncate font-mono text-[10px]">
                {file.originalPath ? `${file.originalPath} → ` : ""}
                {dir}
              </span>
            </span>
            {file.added === null && file.deleted === null ? (
              <span className="text-muted-foreground shrink-0 text-[10px]">binary</span>
            ) : (
              <span className="shrink-0 text-[11px] tabular-nums">
                <span className="text-emerald-600 dark:text-emerald-400">+{file.added ?? 0}</span>{" "}
                <span className="text-red-600 dark:text-red-400">−{file.deleted ?? 0}</span>
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** The loading and error states the file list shows before it can render rows. */
export function CommitFilesStatus({
  loading,
  error,
  copy = "Reading the commit…",
}: {
  loading: boolean;
  error: string | null;
  copy?: string;
}) {
  if (error) return <p className="text-destructive px-3 py-2 text-xs break-words">{error}</p>;
  if (!loading) return null;
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <Loader2 className="text-muted-foreground h-3.5 w-3.5 animate-spin" />
      <span className="text-muted-foreground text-xs">{copy}</span>
    </div>
  );
}
