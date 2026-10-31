/**
 * HTTP details shared by the file endpoints.
 *
 * Lifted from the single-file workspace route so a download, a preview and a zip
 * answer the same way. in particular the same ETag semantics: a workspace file
 * is mutable but its URL is not, so a cached response must be revalidated or
 * Download hands back whatever bytes were fetched first.
 */

import { createHash } from "crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { FILE_MODIFIED_HEADER } from "./config";
import { inlineSafeType } from "./mime";

/** A strong ETag over a payload's bytes. the only stable identity it has. */
export function contentEtag(payload: Uint8Array): string {
  return `"${createHash("sha1").update(payload).digest("hex")}"`;
}

/**
 * An ETag over what a stat says.
 *
 * A file streamed to the client was never in memory to hash, and hashing it
 * first would read the whole thing twice. Size and mtime move on every write,
 * which is what the revalidation is for.
 */
export function statEtag(size: number, modified: number): string {
  return `"${size.toString(16)}-${Math.trunc(modified).toString(16)}"`;
}

/** `If-None-Match` may carry a list of tags and weak-tag prefixes. */
export function matchesEtag(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch.split(",").some((candidate) => candidate.trim().replace(/^W\//, "") === etag);
}

/**
 * `Content-Disposition` for `fileName`.
 *
 * Both forms are sent: a quoted ASCII `filename` every client understands, and
 * RFC 5987 `filename*` so a non-ASCII name survives intact.
 */
export function contentDisposition(fileName: string, inline = false): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const kind = inline ? "inline" : "attachment";
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** A file about to be served, as its stat describes it. */
export interface StreamedFile {
  stream: ReadableStream<Uint8Array>;
  /** Last path segment, which is what the browser saves the file as. */
  name: string;
  mimeType: string;
  size: number;
  /** Epoch milliseconds of the stat these bytes belong to. */
  modified: number;
  /** Save the file rather than render it. */
  download: boolean;
}

/**
 * Serve a file's bytes as they are read off the disk.
 *
 * The reason this exists at all: a whole-file buffer is an out-of-memory kill
 * for the app, and a workspace can hold a file far larger than the server's
 * heap. Nothing between here and the socket needs the bytes in hand.
 */
export function streamedFileResponse(request: NextRequest, file: StreamedFile): NextResponse {
  const etag = statEtag(file.size, file.modified);
  const revalidating = { ETag: etag, "Cache-Control": "private, no-cache" };

  if (matchesEtag(request.headers.get("if-none-match"), etag)) {
    return new NextResponse(null, {
      status: 304,
      headers: { ...revalidating, [FILE_MODIFIED_HEADER]: String(file.modified) },
    });
  }

  return new NextResponse(file.stream, {
    headers: {
      ...revalidating,
      "Content-Type": file.download ? file.mimeType : inlineSafeType(file.mimeType),
      "Content-Length": String(file.size),
      "X-Content-Type-Options": "nosniff",
      [FILE_MODIFIED_HEADER]: String(file.modified),
      ...(file.download ? { "Content-Disposition": contentDisposition(file.name) } : {}),
    },
  });
}
