"use client";

import { useState, useEffect } from "react";
import { Download, Image as ImageIcon, FileText, File, Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { downloadFile } from "@/lib/download";
import { LightboxImage } from "./image-lightbox";
import type { ToolCallData } from "./types";

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

/** The endpoint that serves a workspace file to its owner. */
function workspaceFileUrl(filePath: string, { download = false } = {}): string {
  const url = `/api/chat/workspace-files?file=${encodeURIComponent(filePath)}`;
  return download ? `${url}&download=1` : url;
}

/** One `show_file` call, read into the parts every presentation of it needs. */
interface SharedFile {
  id: string;
  filePath: string;
  fileName: string;
  mimeType: string | undefined;
  description: string | undefined;
  isImage: boolean;
  isError: boolean;
  errorMessage: string | undefined;
}

function readSharedFile(toolCall: ToolCallData): SharedFile {
  const filePath = typeof toolCall.args.filePath === "string" ? toolCall.args.filePath : "";
  const mimeType = guessMimeType(filePath);

  return {
    id: toolCall.id,
    filePath,
    fileName: basename(filePath),
    mimeType,
    description:
      typeof toolCall.args.description === "string" ? toolCall.args.description : undefined,
    isImage: Boolean(mimeType?.startsWith("image/")),
    isError: toolCall.status === "error" || Boolean(toolCall.error),
    errorMessage: toolCall.error,
  };
}

/**
 * Why an image has no preview: gone from the workspace, or unreadable.
 *
 * A shared `show_file` is a path, and the path is read again every time the
 * transcript renders. a chat opened tomorrow asks for bytes an agent wrote
 * today. So a file that was deleted in between is a normal outcome, not a bug,
 * and it has to say so: a blank tile with no reason reads as a broken app.
 */
type PreviewFailure = "missing" | "failed";

const PREVIEW_FAILURE_COPY: Record<PreviewFailure, { tile: string; card: string }> = {
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
 * when the card unmounts or the path changes.
 */
function useFilePreview(
  filePath: string,
  enabled: boolean,
): { url: string | null; failure: PreviewFailure | null } {
  const [url, setUrl] = useState<string | null>(null);
  const [failure, setFailure] = useState<PreviewFailure | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const controller = new AbortController();
    setFailure(null);

    fetch(workspaceFileUrl(filePath), { signal: controller.signal, credentials: "include" })
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
  }, [filePath, enabled]);

  return { url, failure };
}

/**
 * The download control. `iconOnly` is for a gallery tile, where the file name
 * beside it already says what is being downloaded.
 *
 * The file is fetched from the server rather than assembled in the browser: a
 * blob built here is invisible to the download manager, which is what left an
 * installed web app on `about:blank`. See `downloadFile`.
 */
function DownloadButton({ file, iconOnly = false }: { file: SharedFile; iconOnly?: boolean }) {
  return (
    <Button
      variant="secondary"
      size={iconOnly ? "icon-sm" : "sm"}
      className="shrink-0"
      onClick={() => void downloadFile(workspaceFileUrl(file.filePath, { download: true }))}
      aria-label={`Download ${file.fileName}`}
    >
      <Download className={iconOnly ? "size-3.5" : "h-3.5 w-3.5"} />
      {!iconOnly && "Download"}
    </Button>
  );
}

/** The mark for a file, from the MIME type its extension suggests. */
function FileTypeIcon({ file }: { file: SharedFile }) {
  const Icon = file.isImage
    ? ImageIcon
    : file.mimeType === "application/pdf" || file.mimeType?.startsWith("text/")
      ? FileText
      : File;

  return <Icon className="text-muted-foreground h-4 w-4" />;
}

/** A shared file that could not be produced. the reason is the whole card. */
function SharedFileError({ file }: { file: SharedFile }) {
  return (
    <div className="liquid-glass-inner flex min-w-0 items-center gap-3 rounded-xl px-3 py-2">
      <AlertCircle className="text-destructive h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">{file.fileName}</p>
        <p className="text-muted-foreground text-[11px]">
          {file.errorMessage || "Failed to share file"}
        </p>
      </div>
    </div>
  );
}

/** A non-image attachment: one compact row, with its download. */
function SharedFileRow({ file }: { file: SharedFile }) {
  return (
    <div className="liquid-glass-inner flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2">
      <div className="bg-muted/50 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
        <FileTypeIcon file={file} />
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">{file.fileName}</p>
        {file.description && (
          <p className="text-muted-foreground truncate text-[11px]">{file.description}</p>
        )}
      </div>

      <DownloadButton file={file} iconOnly />
    </div>
  );
}

/** An image attachment: a square thumbnail that opens the lightbox. */
function SharedImageTile({ file }: { file: SharedFile }) {
  const { url, failure } = useFilePreview(file.filePath, true);

  return (
    <div className="liquid-glass-inner min-w-0 overflow-hidden rounded-xl">
      {url && !failure ? (
        <LightboxImage
          src={url}
          alt={file.fileName}
          wrapperClassName="block w-full"
          className="aspect-square w-full object-cover"
        />
      ) : (
        <div className="bg-muted/40 flex aspect-square w-full flex-col items-center justify-center gap-1 px-2 text-center">
          {failure ? (
            <>
              <AlertCircle className="text-muted-foreground h-5 w-5" />
              <span className="text-muted-foreground text-[11px]">
                {PREVIEW_FAILURE_COPY[failure].tile}
              </span>
            </>
          ) : (
            <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
          )}
        </div>
      )}

      <div className="flex min-w-0 items-center gap-1.5 px-2 py-1.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{file.fileName}</p>
          {file.description && (
            <p className="text-muted-foreground truncate text-[11px]">{file.description}</p>
          )}
        </div>
        <DownloadButton file={file} iconOnly />
      </div>
    </div>
  );
}

/** A `show_file` call whose arguments are still being written: no file yet. */
function SharedFilePending() {
  return (
    <div className="liquid-glass-inner flex min-w-0 items-center gap-3 rounded-xl px-4 py-3">
      <Loader2 className="text-muted-foreground h-4 w-4 shrink-0 animate-spin" />
      <p className="text-muted-foreground text-xs">Preparing file…</p>
    </div>
  );
}

/**
 * A `show_file` call: the file the assistant shared, as an attachment.
 *
 * Deliberately not a `ToolCard`. a shared file is not a report of what a call
 * did, so it has no card model and nothing to collapse. The file itself
 * (preview, name, download) is the content.
 */
export function ShowFileCard({ toolCall }: { toolCall: ToolCallData }) {
  const file = readSharedFile(toolCall);
  const { url, failure } = useFilePreview(file.filePath, file.isImage && !file.isError);

  // The model is still writing this call's arguments, so there is no file
  // behind it yet. An attachment with a half-written name and a download that
  // cannot work reads as broken.
  if (toolCall.status === "pending") return <SharedFilePending />;

  if (file.isError) return <SharedFileError file={file} />;

  return (
    <div className="liquid-glass-inner overflow-hidden rounded-xl">
      {file.isImage && url && !failure && (
        <div className="border-border/30 border-b">
          <LightboxImage
            src={url}
            alt={file.fileName}
            wrapperClassName="w-full"
            className="bg-muted/40 h-auto max-h-64 w-full object-contain"
          />
        </div>
      )}

      {file.isImage && failure && (
        <div className="border-border/30 bg-muted/30 flex items-center gap-2 border-b px-4 py-2">
          <AlertCircle className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
          <p className="text-muted-foreground text-[11px] break-words">
            {PREVIEW_FAILURE_COPY[failure].card}
          </p>
        </div>
      )}

      <div className="flex min-w-0 items-center gap-3 px-4 py-3">
        <div className="bg-muted/50 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
          <FileTypeIcon file={file} />
        </div>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{file.fileName}</p>
          {file.description && (
            <p className="text-muted-foreground line-clamp-1 text-xs">{file.description}</p>
          )}
        </div>

        <DownloadButton file={file} />
      </div>
    </div>
  );
}

/**
 * The files one turn showed the assistant's user, as a gallery.
 *
 * Images become a thumbnail grid (each opening the lightbox) and every other
 * file a row of its own. It is never collapsed: the agent chose to show these,
 * so they are the point of the call, not a report of it.
 */
export function ShowFileGallery({ toolCalls }: { toolCalls: readonly ToolCallData[] }) {
  const files = toolCalls.map(readSharedFile);
  const images = files.filter((file) => file.isImage && !file.isError);
  const rows = files.filter((file) => !file.isImage || file.isError);

  return (
    <div className="space-y-1.5">
      {images.length > 0 && (
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          {images.map((file) => (
            <SharedImageTile key={file.id} file={file} />
          ))}
        </div>
      )}

      {rows.map((file) =>
        file.isError ? (
          <SharedFileError key={file.id} file={file} />
        ) : (
          <SharedFileRow key={file.id} file={file} />
        ),
      )}
    </div>
  );
}

/** The last segment of a path, without importing `path` into client code. */
function basename(filePath: string): string {
  const segments = filePath.replace(/\\/g, "/").split("/");
  return segments[segments.length - 1] || filePath;
}

function guessMimeType(filePath: string): string | undefined {
  const extension = filePath.split(".").pop()?.toLowerCase();
  if (!extension) return undefined;
  return MIME_TYPES[extension] ?? "application/octet-stream";
}
