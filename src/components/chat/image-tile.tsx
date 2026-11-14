"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The longest side a picture in a transcript takes. */
export const IMAGE_FRAME_MAX_EDGE = 360;

/**
 * The box a rendered picture sits in, at the picture's own shape.
 *
 * A render comes back at whichever resolution the account asked for, so the box
 * follows the aspect ratio instead of stretching to the card's width: a square
 * render stays square, and a 2K widescreen one is scaled down rather than cut
 * into a band with empty sides. Holding the shape before the bytes arrive also
 * keeps the transcript from jumping when they do.
 */
export function ImageFrame({
  width,
  height,
  className,
  children,
}: {
  width?: number | undefined;
  height?: number | undefined;
  className?: string;
  children: ReactNode;
}) {
  const ratio = width && height && width > 0 && height > 0 ? width / height : 1;
  const maxWidth = ratio >= 1 ? IMAGE_FRAME_MAX_EDGE : Math.round(IMAGE_FRAME_MAX_EDGE * ratio);

  return (
    <div
      className={cn(
        "bg-muted border-border relative mx-auto overflow-hidden rounded-lg border",
        className,
      )}
      style={{ aspectRatio: String(ratio), width: "100%", maxWidth }}
    >
      {children}
    </div>
  );
}

/**
 * A picture inside an `ImageFrame`, filling it.
 *
 * `object-contain` because the frame follows the resolution the account asked
 * for and an endpoint is free to answer with another one.
 */
export function FramedImage({
  src,
  alt,
  width,
  height,
}: {
  src: string;
  alt: string;
  width?: number | undefined;
  height?: number | undefined;
}) {
  return (
    <ImageFrame width={width} height={height}>
      {/* A blob or bearer URL: next/image cannot size what it cannot fetch. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} className="h-full w-full object-contain" />
    </ImageFrame>
  );
}
