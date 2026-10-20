/**
 * HTTP details shared by the file endpoints.
 *
 * Lifted from the single-file workspace route so a download, a preview and a zip
 * answer the same way. in particular the same ETag semantics: a workspace file
 * is mutable but its URL is not, so a cached response must be revalidated or
 * Download hands back whatever bytes were fetched first.
 */

import { createHash } from "crypto";

/** A strong ETag over a payload's bytes. the only stable identity it has. */
export function contentEtag(payload: Uint8Array): string {
  return `"${createHash("sha1").update(payload).digest("hex")}"`;
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
