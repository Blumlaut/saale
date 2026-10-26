"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Loader2, X } from "lucide-react";
import dynamic from "next/dynamic";
import { useTheme } from "next-themes";
import { fetchJson } from "@/lib/http";
import { formatRelativeDate } from "@/lib/format";
import { basenameOf, languageFromPath, previewKindFromPath } from "@/lib/editor/editor-utils";
import { DiffImage } from "./diff-image";
import {
  CommitFileList,
  CommitFilesStatus,
  commitDiffUrl,
  splitPath,
  useCommitFiles,
} from "./commit-files";
import type { CommitDiffFileContent, CoderCommit } from "./use-coder-data";

// Monaco touches window at module scope; keep it out of the SSR bundle.
const MonacoDiffView = dynamic(
  () => import("@/components/editor/monaco-diff-view").then((m) => m.MonacoDiffView),
  { ssr: false },
);

/**
 * The Diff tab: one commit's file list, and the selected file's two sides in
 * a diff editor. Drilling in keeps the panel one column wide, which a
 * side-by-side diff would not be.
 *
 * `initialPath` is the file the caller already picked, so opening a file from
 * the commit list lands on its diff instead of on the list again.
 */
export function CommitDiffView({
  sessionId,
  commit,
  initialPath = null,
  onClose,
}: {
  sessionId: string;
  commit: CoderCommit;
  initialPath?: string | null;
  onClose: () => void;
}) {
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === "dark" ? "dark" : "light";
  const { files, error: filesError, loading: filesLoading } = useCommitFiles(sessionId, commit.sha);
  const [selectedPath, setSelectedPath] = useState<string | null>(initialPath);
  const [content, setContent] = useState<CommitDiffFileContent | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(initialPath !== null);
  // Rapid clicks must not let a slow response for one file land on another.
  const requestRef = useRef(0);
  const shaRef = useRef(commit.sha);

  const openFile = useCallback(
    (path: string) => {
      const request = ++requestRef.current;
      setSelectedPath(path);
      setContent(null);
      setContentError(null);
      setLoadingContent(true);

      fetchJson<CommitDiffFileContent>(commitDiffUrl(sessionId, commit.sha, path))
        .then((body) => {
          if (request !== requestRef.current) return;
          setContent(body);
        })
        .catch((err) => {
          if (request !== requestRef.current) return;
          console.error(`Failed to load ${path} from ${commit.shortSha}:`, err);
          setContentError(err instanceof Error ? err.message : "Could not read this file.");
        })
        .finally(() => {
          if (request === requestRef.current) setLoadingContent(false);
        });
    },
    [sessionId, commit.sha, commit.shortSha],
  );

  const back = useCallback(() => {
    requestRef.current += 1;
    setSelectedPath(null);
    setContent(null);
    setContentError(null);
    setLoadingContent(false);
  }, []);

  // The commit's list says whether the path the caller picked is really in it.
  useEffect(() => {
    if (!initialPath || !files) return;
    if (!files.some((file) => file.path === initialPath)) return;
    openFile(initialPath);
  }, [initialPath, files, openFile]);

  // Another commit in the same mounted view starts back at its file list.
  useEffect(() => {
    if (shaRef.current === commit.sha) return;
    shaRef.current = commit.sha;
    back();
  }, [commit.sha, back]);

  const selected = selectedPath ? (files ?? []).find((file) => file.path === selectedPath) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b px-3 py-2">
        {selected ? (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={back}
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
              onClick={onClose}
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
              <p className="text-muted-foreground mt-0.5 text-[10px] tabular-nums">
                {commit.author} · {formatRelativeDate(commit.date)}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close the diff tab"
              className="text-muted-foreground hover:text-foreground shrink-0 rounded p-1 transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {selected ? (
          loadingContent ? (
            <div className="flex h-full items-center justify-center gap-2">
              <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
              <span className="text-muted-foreground text-xs">Reading the file…</span>
            </div>
          ) : contentError ? (
            <p className="text-destructive px-3 py-3 text-xs break-words">{contentError}</p>
          ) : content?.binary ? (
            content.preview && previewKindFromPath(content.preview.path) === "image" ? (
              <div className="h-full overflow-auto py-2">
                <DiffImage
                  sessionId={sessionId}
                  path={content.preview.path}
                  sha={content.preview.sha}
                />
              </div>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
                <p className="text-xs font-medium">Binary file</p>
                <p className="text-muted-foreground text-xs">
                  {basenameOf(content.path)} has no text form, so there is nothing to diff here.
                </p>
              </div>
            )
          ) : content ? (
            <MonacoDiffView
              key={content.path}
              path={content.path}
              original={content.original ?? ""}
              modified={content.modified ?? ""}
              language={languageFromPath(content.path)}
              theme={theme}
            />
          ) : null
        ) : (
          <div className="h-full overflow-y-auto">
            <CommitFilesStatus
              loading={filesLoading}
              error={filesError}
              copy="Reading the commit…"
            />
            {files && <CommitFileList files={files} onSelect={(file) => openFile(file.path)} />}
          </div>
        )}
      </div>
    </div>
  );
}
