"use client";

import { useState, useCallback, useEffect } from "react";
import { Download, Image as ImageIcon, FileText, File, Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
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

interface FileCardProps {
  filePath: string;
  fileName: string;
  mimeType: string | undefined;
  size: number | undefined;
  description: string | undefined;
  isError: boolean;
  errorMessage: string | undefined;
}

/** Format byte size for display */
function formatSize(bytes: number): string {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function FileCard({
  filePath,
  fileName,
  mimeType = undefined,
  size = undefined,
  description = undefined,
  isError = false,
  errorMessage = undefined,
}: FileCardProps) {
  const [loading, setLoading] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageError, setImageError] = useState(false);

  const isImage = mimeType?.startsWith("image/");

  // Pick icon based on MIME type (static component references, not function calls)
  const Icon = isImage
    ? ImageIcon
    : mimeType === "application/pdf"
      ? FileText
      : mimeType?.startsWith("text/")
        ? FileText
        : File;

  // Load image preview on mount (for images only)
  useEffect(() => {
    if (!isImage) return;

    const controller = new AbortController();
    fetch(`/api/chat/workspace-files?file=${encodeURIComponent(filePath)}`, {
      signal: controller.signal,
      credentials: "include",
    })
      .then((res) => {
        if (!res.ok) throw new Error("Failed");
        return res.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        setImageUrl(url);
      })
      .catch((err: unknown) => {
        // An abort is this effect cleaning up, not a failure to load.
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("Failed to load the workspace file preview:", err);
        setImageError(true);
      });

    return () => {
      controller.abort();
      setImageUrl((url) => {
        if (url) URL.revokeObjectURL(url);
        return null;
      });
    };
  }, [filePath, isImage]);

  const handleDownload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/chat/workspace-files?file=${encodeURIComponent(filePath)}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to download");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Failed to download a workspace file:", err);
    } finally {
      setLoading(false);
    }
  }, [filePath, fileName]);

  if (isError) {
    return (
      <div className="liquid-glass-inner flex items-center gap-3 rounded-xl px-4 py-3">
        <AlertCircle className="text-destructive h-5 w-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{fileName}</p>
          <p className="text-muted-foreground text-xs">{errorMessage || "Failed to share file"}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="liquid-glass-inner overflow-hidden rounded-xl">
      {/* Image preview */}
      {isImage && imageUrl && !imageError && (
        <div className="border-border/30 border-b">
          <LightboxImage
            src={imageUrl}
            alt={fileName}
            wrapperClassName="w-full"
            className="h-auto max-h-64 w-full bg-black/5 object-contain"
          />
        </div>
      )}

      {/* File info row */}
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="bg-muted/50 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
          <Icon className="text-muted-foreground h-4 w-4" />
        </div>

        <div className="min-w-0 flex-1">
          {description && (
            <p className="text-muted-foreground line-clamp-1 text-xs">{description}</p>
          )}
          <p className="truncate text-sm font-medium">{fileName}</p>
          {size !== undefined && (
            <p className="text-muted-foreground text-xs">{formatSize(size)}</p>
          )}
        </div>

        <Button
          variant="secondary"
          size="sm"
          className="shrink-0 rounded-full"
          onClick={handleDownload}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="mr-1.5 h-3.5 w-3.5" />
          )}
          Download
        </Button>
      </div>
    </div>
  );
}

/**
 * A `show_file` call: the file the assistant shared, as an attachment.
 *
 * Deliberately not a `ToolCard` — a shared file is not a report of what a call
 * did, so it has no card model. The file itself (preview, name, download) is
 * the content, and there is nothing to collapse.
 */
export function ShowFileCard({ toolCall }: { toolCall: ToolCallData }) {
  const filePath = typeof toolCall.args.filePath === "string" ? toolCall.args.filePath : "";
  const description =
    typeof toolCall.args.description === "string" ? toolCall.args.description : undefined;
  const isError = toolCall.status === "error" || Boolean(toolCall.error);

  return (
    <FileCard
      filePath={filePath}
      fileName={basename(filePath)}
      mimeType={guessMimeType(filePath)}
      size={undefined}
      description={description}
      isError={isError}
      errorMessage={toolCall.error}
    />
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
