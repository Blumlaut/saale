"use client";

/**
 * Rendered previews for files the editor cannot show as text (images, video,
 * PDF) and for the rendered form of markdown and HTML. Media streams from the
 * raw endpoint; markdown and HTML use the text the viewer already fetched; a
 * PDF is read into an object URL so the browser's viewer can show it. The raw
 * endpoint serves executable types as plain text and marks the response
 * no-cache, so all of them stay inert and fresh.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { MarkdownRenderer } from "@/components/chat/markdown-renderer";
import { rawFileUrl } from "@/lib/files/urls";
import type { FileEntry } from "@/lib/files/types";

export interface FilePreviewProps {
  target: string;
  entry: FileEntry;
  /** What the preview renders; media, pdf and markdown | html alike. */
  kind: "image" | "video" | "markdown" | "html" | "pdf";
  /** markdown | html — the text the viewer already fetched. */
  content?: string | undefined;
}

export function FilePreview({ target, entry, kind, content }: FilePreviewProps) {
  if (kind === "image" || kind === "video") {
    // Its own scroller: a wide media file pans instead of stretching the
    // sheet.
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-md border p-3">
        {kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element -- raw endpoint URL, sized by the container
          <img
            src={rawFileUrl(target, entry.path)}
            alt={entry.name}
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <video src={rawFileUrl(target, entry.path)} controls className="max-h-full max-w-full" />
        )}
      </div>
    );
  }
  if (kind === "markdown")
    return <MarkdownPreview target={target} entry={entry} content={content} />;
  if (kind === "pdf") return <PdfPreview target={target} entry={entry} />;
  // html — sandboxed without scripts, so a page can only show itself
  return (
    <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
      <iframe
        title={entry.name}
        sandbox=""
        srcDoc={content ?? ""}
        className="h-full w-full border-0 bg-white"
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  PDF                                                                */
/* ------------------------------------------------------------------ */

/**
 * A PDF, handed to the viewer the browser already ships.
 *
 * It arrives as an object URL rather than the raw endpoint's own URL: the
 * response carries `X-Frame-Options: DENY` and `frame-ancestors 'none'`, which
 * every page here needs and which would stop the frame from loading. A blob of
 * the same bytes has no headers to answer to, and the browser decides from its
 * own type how to render it.
 */
function PdfPreview({ target, entry }: { target: string; entry: FileEntry }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setUrl(null);
    setError("");

    void (async () => {
      try {
        // `no-store`, like the editor's read: a revalidated response is a 304
        // with no bytes on it.
        const response = await fetch(rawFileUrl(target, entry.path), {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Could not open this file (${response.status}).`);
        }
        objectUrl = URL.createObjectURL(await response.blob());
        setUrl(objectUrl);
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error("[file-preview] failed to read pdf:", err);
        setError(err instanceof Error ? err.message : "Could not open this file.");
      }
    })();

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [target, entry.path]);

  if (error) return <p className="text-destructive text-sm break-words">{error}</p>;
  return (
    <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
      {url ? (
        <iframe title={entry.name} src={url} className="h-full w-full border-0 bg-white" />
      ) : (
        <div className="flex h-full items-center justify-center">
          <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Markdown                                                           */
/* ------------------------------------------------------------------ */

function MarkdownPreview({
  target,
  entry,
  content,
}: {
  target: string;
  entry: FileEntry;
  content?: string | undefined;
}) {
  // Stable across renders: a new resolver would rebuild every image.
  const resolveImageSrc = useCallback(
    (src: string | Blob | undefined) => resolveLocalPreviewImage(src, target, entry.path),
    [target, entry.path],
  );
  return (
    <MarkdownRenderer
      content={content ?? ""}
      hardBreaks
      resolveImageSrc={resolveImageSrc}
      className="min-h-0 flex-1 overflow-y-auto rounded-md border p-4"
    />
  );
}

/* ------------------------------------------------------------------ */
/*  Markdown local images                                              */
/* ------------------------------------------------------------------ */

/**
 * Where a preview's image `src` points: a relative reference resolves against
 * the raw endpoint, so a page's `![diagram](./diagrams/x.png)` renders.
 * Absolute, remote, data: and unresolvable paths pass through.
 */
function resolveLocalPreviewImage(
  src: string | Blob | undefined,
  target: string,
  filePath: string,
): string | undefined {
  // A non-string src is not a path we can resolve, and <img> takes none.
  if (typeof src !== "string") return undefined;
  if (!src) return src;
  const trimmed = src.trim();
  if (
    !trimmed ||
    trimmed.startsWith("data:") ||
    trimmed.startsWith("blob:") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("/") ||
    /^[a-z]+:\/\//i.test(trimmed)
  ) {
    return src;
  }
  const baseDir = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
  const combined = baseDir ? `${baseDir}/${trimmed.replace(/^\.\//, "")}` : trimmed;
  const resolvedPath = decodePathSegments(combined);
  if (resolvedPath.split("/").some((segment) => segment === "..")) return src;
  return rawFileUrl(target, resolvedPath);
}

function decodePathSegments(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        // A stray "%" in a file name is not an error: show the segment as written.
        return segment;
      }
    })
    .join("/");
}
