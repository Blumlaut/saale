"use client";

import { AlertCircle, Loader2 } from "lucide-react";
import { ImageFrame } from "./image-tile";
import { LightboxImage } from "./image-lightbox";
import { basename, PREVIEW_FAILURE_COPY, useFilePreview } from "./workspace-file";

/**
 * An image from the user's workspace, inside a tool card.
 *
 * A call only carries the path (a `read` of a screenshot, say), so the bytes
 * are fetched when the card is unfolded and opened full-screen on click. The
 * frame takes the size the call reported, so the card shows the picture at its
 * own shape instead of stretching it across the transcript.
 */
export function WorkspaceImage({
  path,
  width,
  height,
}: {
  path: string;
  width?: number | undefined;
  height?: number | undefined;
}) {
  const { url, failure } = useFilePreview(path, true);
  const label = basename(path);

  if (!url || failure) {
    return (
      <ImageFrame width={width} height={height}>
        <div className="flex h-full flex-col items-center justify-center gap-2 px-3 text-center">
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
      </ImageFrame>
    );
  }

  return (
    <ImageFrame width={width} height={height}>
      <LightboxImage
        src={url}
        alt={label}
        wrapperClassName="h-full w-full"
        className="h-full w-full object-contain"
      />
    </ImageFrame>
  );
}
