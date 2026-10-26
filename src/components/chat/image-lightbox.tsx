"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * Full-viewport image viewer. Clicking outside or pressing Escape closes it.
 */
export function ImageLightbox({
  open,
  onOpenChange,
  src,
  alt,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  src: string;
  alt: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Inset full-screen popup: the image viewer *is* the window, so it
          opts out of the centered-card geometry (size, radius, translate). */}
      <DialogContent className="inset-0 top-0 left-0 flex h-full max-h-full w-full translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none p-0 sm:max-w-none">
        <DialogTitle className="sr-only">{alt}</DialogTitle>
        <div className="flex min-h-0 flex-1 items-center justify-center bg-black/90 p-2 md:p-4">
          {/* eslint-disable-next-line @next/next/no-img-element -- dynamic image served by the app */}
          <img src={src} alt={alt} className="max-h-full max-w-full object-contain" />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Inline image that opens the full-viewport lightbox on click/tap.
 *
 * `wrapperClassName` sizes the trigger (it is the box that flexbox lays out),
 * `className` styles the image itself.
 */
export function LightboxImage({
  src,
  alt,
  className,
  wrapperClassName,
  onError,
}: {
  src: string;
  alt: string;
  className?: string;
  wrapperClassName?: string;
  onError?: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`View ${alt}`}
        title={`View ${alt}`}
        onClick={() => setOpen(true)}
        className={cn("h-auto shrink-0 cursor-zoom-in overflow-hidden p-0", wrapperClassName)}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- dynamic image served by the app */}
        <img src={src} alt={alt} onError={onError} className={cn("block max-w-full", className)} />
      </Button>
      <ImageLightbox open={open} onOpenChange={setOpen} src={src} alt={alt} />
    </>
  );
}
