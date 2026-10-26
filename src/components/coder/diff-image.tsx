"use client";

import { useState } from "react";
import { LightboxImage } from "@/components/chat/image-lightbox";
import { basenameOf } from "@/lib/editor/editor-utils";

/** The blob endpoint for one path in a chat's checkout; a sha asks for a commit's copy. */
export function sessionBlobUrl(sessionId: string, path: string, sha?: string | null): string {
  const query = new URLSearchParams({ path });
  if (sha) query.set("sha", sha);
  return `/api/coder/sessions/${encodeURIComponent(sessionId)}/blob?${query.toString()}`;
}

/**
 * An image where a diff has no text to show. Click opens it full-screen, like
 * every other image in the app.
 *
 * The file can be gone by the time the panel renders it, so a failed load says
 * so instead of leaving a broken tile.
 */
export function DiffImage({
  sessionId,
  path,
  sha,
}: {
  sessionId: string;
  path: string;
  sha?: string | null;
}) {
  const [failed, setFailed] = useState(false);
  const alt = basenameOf(path);

  if (failed) {
    return (
      <p className="text-muted-foreground px-3 py-2 text-xs">This image could not be loaded.</p>
    );
  }

  return (
    <LightboxImage
      src={sessionBlobUrl(sessionId, path, sha)}
      alt={alt}
      wrapperClassName="mx-2 mb-2 flex max-h-80 items-center justify-center bg-muted/40"
      className="max-h-72 object-contain p-1"
      onError={() => setFailed(true)}
    />
  );
}
