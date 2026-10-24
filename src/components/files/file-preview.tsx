"use client";

/**
 * Rendered previews for files the editor cannot show as text (images and
 * video) and for the rendered form of markdown and HTML. Media streams from
 * the raw endpoint; markdown and HTML use the text the viewer already
 * fetched. The raw endpoint serves executable types as plain text and marks
 * the response no-cache, so both stay inert and fresh.
 */

import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { rawFileUrl } from "@/lib/files/urls";
import type { FileEntry } from "@/lib/files/types";

export interface FilePreviewProps {
  target: string;
  entry: FileEntry;
  /** What the preview renders; media and markdown | html alike. */
  kind: "image" | "video" | "markdown" | "html";
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
  // Stable across renders: a new component type would remount every image
  // and restart its fetch.
  const LocalImage = useMemo(() => localPreviewImage(target, entry.path), [target, entry.path]);
  return (
    <div className="markdown-body min-h-0 flex-1 overflow-y-auto rounded-md border p-4 text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkBreaks, remarkGfm]}
        rehypePlugins={[
          [rehypeHighlight, { detect: true, ignoreMissing: true, placeholderLanguage: "text" }],
        ]}
        components={{ img: LocalImage }}
      >
        {content ?? ""}
      </ReactMarkdown>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Markdown local images                                              */
/* ------------------------------------------------------------------ */

/**
 * A react-markdown img component that resolves relative image references to
 * the raw endpoint, so a page's `![diagram](./diagrams/x.png)` renders in the
 * preview. Absolute, remote, data: and unresolvable paths pass through.
 */
function localPreviewImage(target: string, filePath: string) {
  return function LocalImage({ src, alt, ...rest }: React.ImgHTMLAttributes<HTMLImageElement>) {
    // eslint-disable-next-line @next/next/no-img-element -- resolved to the raw endpoint
    return <img src={resolveLocalPreviewImage(src, target, filePath)} alt={alt ?? ""} {...rest} />;
  };
}

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
        return segment;
      }
    })
    .join("/");
}
