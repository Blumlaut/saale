"use client";

import { AlertCircle, Loader2 } from "lucide-react";
import { LightboxImage } from "./image-lightbox";
import { basename, PREVIEW_FAILURE_COPY, useFilePreview } from "./workspace-file";

/**
 * An image from the user's workspace, inside a tool card.
 *
 * A call only carries the path (a `read` of a screenshot, say), so the bytes
 * are fetched when the card is unfolded and opened full-screen on click.
 */
export function WorkspaceImage({ path }: { path: string }) {
  const { url, failure } = useFilePreview(path, true);
  const label = basename(path);

  if (!url || failure) {
    return (
      <div className="bg-muted flex h-24 items-center justify-center gap-2 rounded-lg px-3 text-center">
        {failure ? (
          <>
            <AlertCircle className="text-muted-foreground h-4 w-4 shrink-0" />
            <span className="text-muted-foreground text-[11px]">
              {PREVIEW_FAILURE_COPY[failure].card}
            </span>
          </>
        ) : (
          <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
        )}
      </div>
    );
  }

  return (
    <LightboxImage
      src={url}
      alt={label}
      wrapperClassName="block w-full"
      className="bg-muted h-auto max-h-64 w-full rounded-lg object-contain"
    />
  );
}
