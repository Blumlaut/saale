"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Loader2, X } from "lucide-react";
import dynamic from "next/dynamic";
import { useTheme } from "next-themes";
import { fetchJson } from "@/lib/http";
import { formatRelativeDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { basenameOf, languageFromPath } from "@/lib/editor/editor-utils";
import type { CommitDiffFile, CommitDiffFileContent, CoderCommit } from "./use-coder-data";

// Monaco touches window at module scope; keep it out of the SSR bundle.
const MonacoDiffView = dynamic(
  () => import("@/components/editor/monaco-diff-view").then((m) => m.MonacoDiffView),
  { ssr: false },
);

/** The status letter a git user reads in half a second. */
function statusStyle(status: string): string {
  if (status === "A") return "text-emerald-600 dark:text-emerald-400";
  if (status === "D") return "text-red-600 dark:text-red-400";
  if (status === "R" || status === "C") return "text-sky-600 dark:text-sky-400";
  if (status === "M") return "text-amber-600 dark:text-amber-400";
  return "text-muted-foreground";
}

/** A repo path as a file name over its (muted) folder. */
function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf("/");
  if (slash === -1) return { dir: "", name: path };
  return { dir: path.slice(0, slash), name: path.slice(slash + 1) };
}

function commitDiffUrl(sessionId: string, sha: string, path?: string): string {
  const query = new URLSearchParams({ sha });
  if (path) query.set("path", path);
  return `/api/coder/sessions/${encodeURIComponent(sessionId)}/commit-diff?${query.toString()}`;
}

/**
 * The Diff tab: one commit's file list, and the selected file's two sides in
 * a diff editor. Drilling in keeps the panel one column wide, which a
 * side-by-side diff would not be.
 */
export function CommitDiffView({
  sessionId,
  commit,
  onClose,
}: {
  sessionId: string;
  commit: CoderCommit;
  onClose: () => void;
}) {
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === "dark" ? "dark" : "light";
  const [files, setFiles] = useState<CommitDiffFile[] | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState<CommitDiffFileContent | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  // Rapid clicks must not let a slow response for one file land on another.
  const requestRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setFiles(null);
    setFilesError(null);
    setSelectedPath(null);
    setContent(null);
    setContentError(null);

    fetchJson<{ files: CommitDiffFile[] }>(commitDiffUrl(sessionId, commit.sha))
      .then((body) => {
        if (!cancelled) setFiles(body.files);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error(`Failed to load the commit diff for ${commit.shortSha}:`, err);
        setFilesError(err instanceof Error ? err.message : "Could not read this commit.");
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, commit.sha, commit.shortSha]);

  const openFile = useCallback(
    (file: CommitDiffFile) => {
      const request = ++requestRef.current;
      setSelectedPath(file.path);
      setContent(null);
      setContentError(null);
      setLoadingContent(true);

      fetchJson<CommitDiffFileContent>(commitDiffUrl(sessionId, commit.sha, file.path))
        .then((body) => {
          if (request !== requestRef.current) return;
          setContent(body);
        })
        .catch((err) => {
          if (request !== requestRef.current) return;
          console.error(`Failed to load ${file.path} from ${commit.shortSha}:`, err);
          setContentError(err instanceof Error ? err.message : "Could not read this file.");
        })
        .finally(() => {
          if (request === requestRef.current) setLoadingContent(false);
        });
    },
    [sessionId, commit.sha, commit.shortSha],
  );

  const close = () => {
    requestRef.current += 1;
    setSelectedPath(null);
    setContent(null);
    setContentError(null);
    onClose();
  };

  const selected = selectedPath ? (files ?? []).find((file) => file.path === selectedPath) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b px-3 py-2">
        {selected ? (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                requestRef.current += 1;
                setSelectedPath(null);
                setContent(null);
                setContentError(null);
              }}
              aria-label="Back to the commit's files"
              className="text-muted-foreground hover:text-foreground -ml-1 rounded p-1 transition-colors"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </button>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium" title={selected.path}>
                {basenameOf(selected.path)}
              </p>
              <p className="text-muted-foreground truncate font-mono text-[10px]">
                {splitPath(selected.path).dir}
              </p>
            </div>
            <button
              type="button"
              onClick={close}
              aria-label="Close the diff tab"
              className="text-muted-foreground hover:text-foreground rounded p-1 transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="flex items-baseline gap-1.5">
                <span className="text-muted-foreground font-mono text-[11px]">
                  {commit.shortSha}
                </span>
                <span className="min-w-0 truncate text-xs font-medium" title={commit.subject}>
                  {commit.subject}
                </span>
              </p>
              <p className="text-muted-foreground mt-0.5 font-mono text-[10px]">
                {commit.author} · {formatRelativeDate(commit.date)}
              </p>
            </div>
            <button
              type="button"
              onClick={close}
              aria-label="Close the diff tab"
              className="text-muted-foreground hover:text-foreground shrink-0 rounded p-1 transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {files === null && !filesError ? (
          <div className="flex h-full items-center justify-center gap-2">
            <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
            <span className="text-muted-foreground text-xs">Reading the commit…</span>
          </div>
        ) : filesError ? (
          <p className="text-destructive px-3 py-3 text-xs break-words">{filesError}</p>
        ) : !selected ? (
          <div className="h-full overflow-y-auto">
            {(files ?? []).length === 0 ? (
              <p className="text-muted-foreground px-3 py-3 text-xs">
                This commit changes no files.
              </p>
            ) : (
              (files ?? []).map((file) => {
                const { dir, name } = splitPath(file.path);
                return (
                  <button
                    key={file.path}
                    type="button"
                    onClick={() => openFile(file)}
                    className="hover:bg-accent/60 flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors"
                    title={file.originalPath ? `${file.originalPath} → ${file.path}` : file.path}
                  >
                    <span
                      className={cn(
                        "w-3 shrink-0 text-center font-mono text-[11px] font-semibold",
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
                      <span className="text-muted-foreground shrink-0 font-mono text-[10px]">
                        binary
                      </span>
                    ) : (
                      <span className="shrink-0 font-mono text-[11px]">
                        <span className="text-emerald-600 dark:text-emerald-400">
                          +{file.added ?? 0}
                        </span>{" "}
                        <span className="text-red-600 dark:text-red-400">−{file.deleted ?? 0}</span>
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        ) : loadingContent ? (
          <div className="flex h-full items-center justify-center gap-2">
            <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
            <span className="text-muted-foreground text-xs">Reading the file…</span>
          </div>
        ) : contentError ? (
          <p className="text-destructive px-3 py-3 text-xs break-words">{contentError}</p>
        ) : content?.binary ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
            <p className="text-xs font-medium">Binary file</p>
            <p className="text-muted-foreground text-xs">
              {basenameOf(content.path)} has no text form, so there is nothing to diff here.
            </p>
          </div>
        ) : content ? (
          <MonacoDiffView
            key={content.path}
            path={content.path}
            original={content.original ?? ""}
            modified={content.modified ?? ""}
            language={languageFromPath(content.path)}
            theme={theme}
          />
        ) : null}
      </div>
    </div>
  );
}
