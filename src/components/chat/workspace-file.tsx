"use client";

import { createContext, useContext, useEffect, useState } from "react";

/**
 * Reading a file out of a user's workspace for display.
 *
 * `show_file` shows the file it was given, and a `read` of an image shows what
 * the model looked at, so both need the same three things: the URL of the
 * owner's endpoint, the chat the path resolves against, and the bytes as an
 * object URL.
 */

/** MIME types guessed from an extension (client-side, matches the server). */
const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  ts: "text/typescript",
  md: "text/markdown",
  yaml: "text/yaml",
  yml: "text/yaml",
  zip: "application/zip",
  gz: "application/gzip",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
};

/**
 * The chat a path renders: a worktree-relative path belongs to the chat's
 * worktree, so the fetch has to name it.
 */
const SharedFileSessionContext = createContext<string | null>(null);

export function SharedFileSessionProvider({
  sessionId,
  children,
}: {
  sessionId: string | null;
  children: React.ReactNode;
}) {
  return (
    <SharedFileSessionContext.Provider value={sessionId}>
      {children}
    </SharedFileSessionContext.Provider>
  );
}

/** The chat a workspace path resolves against, for callers building their own URL. */
export function useWorkspaceSession(): string | null {
  return useContext(SharedFileSessionContext);
}

/** The endpoint that serves a workspace file to its owner. */
export function workspaceFileUrl(
  filePath: string,
  session: string | null,
  { download = false }: { download?: boolean } = {},
): string {
  const params = new URLSearchParams({ file: filePath });
  if (session) params.set("session", session);
  if (download) params.set("download", "1");
  return `/api/chat/workspace-files?${params.toString()}`;
}

/**
 * Why an image has no preview: gone from the workspace, or unreadable.
 *
 * A card is a path, and the path is read again every time the transcript
 * renders. a chat opened tomorrow asks for bytes an agent wrote today. So a
 * file that was deleted in between is a normal outcome, not a bug, and it has
 * to say so: a blank tile with no reason reads as a broken app.
 */
export type PreviewFailure = "missing" | "failed";

export const PREVIEW_FAILURE_COPY: Record<PreviewFailure, { tile: string; card: string }> = {
  missing: {
    tile: "File not found",
    card: "This file is no longer in the workspace.",
  },
  failed: {
    tile: "Could not load",
    card: "This file could not be loaded.",
  },
};

/**
 * A file's bytes as an object URL, so an image can be previewed.
 *
 * The fetch is explicit rather than an `<img src>`: a preview that fails should
 * say so instead of rendering a broken image, and the URL has to be revoked
 * when the component unmounts or the path changes.
 */
export function useFilePreview(
  filePath: string,
  enabled: boolean,
): { url: string | null; failure: PreviewFailure | null } {
  const [url, setUrl] = useState<string | null>(null);
  const [failure, setFailure] = useState<PreviewFailure | null>(null);

  const session = useWorkspaceSession();

  useEffect(() => {
    if (!enabled) return;

    const controller = new AbortController();
    setFailure(null);

    fetch(workspaceFileUrl(filePath, session), {
      signal: controller.signal,
      credentials: "include",
    })
      .then(async (res) => {
        if (res.status === 404) {
          if (!controller.signal.aborted) setFailure("missing");
          return;
        }
        if (!res.ok) throw new Error(`Failed to load the file (${res.status})`);
        const blob = await res.blob();
        if (!controller.signal.aborted) setUrl(URL.createObjectURL(blob));
      })
      .catch((err: unknown) => {
        // An abort is this effect cleaning up, not a failure to load.
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("Failed to load the workspace file preview:", err);
        setFailure("failed");
      });

    return () => {
      controller.abort();
      setUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return null;
      });
    };
  }, [filePath, session, enabled]);

  return { url, failure };
}

/** The last segment of a path, without importing `path` into client code. */
export function basename(filePath: string): string {
  const segments = filePath.replace(/\\/g, "/").split("/");
  return segments[segments.length - 1] || filePath;
}

export function guessMimeType(filePath: string): string | undefined {
  const extension = filePath.split(".").pop()?.toLowerCase();
  if (!extension) return undefined;
  return MIME_TYPES[extension] ?? "application/octet-stream";
}
