"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";

/**
 * A drag that carries files — an OS drop. Text selections and the app's own
 * reorder drags are left alone: the zone never claims them.
 */
function carriesFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  return Array.from(dataTransfer.types ?? []).includes("Files");
}

export interface FileDropZoneProps {
  onDragEnter: (event: ReactDragEvent<HTMLElement>) => void;
  onDragOver: (event: ReactDragEvent<HTMLElement>) => void;
  onDragLeave: (event: ReactDragEvent<HTMLElement>) => void;
  onDrop: (event: ReactDragEvent<HTMLElement>) => void;
}

/**
 * Accept files dropped onto a surface.
 *
 * Spread `dropZoneProps` onto the element that should take the drop and render
 * something while `isDragging`. The handler never lets the browser default
 * through: a file dropped anywhere on the window would otherwise navigate the
 * tab to it, taking the composer draft (and a running generation) with it.
 */
export function useFileDrop(onFiles: (files: File[]) => void): {
  isDragging: boolean;
  dropZoneProps: FileDropZoneProps;
} {
  const [isDragging, setIsDragging] = useState(false);
  // `dragenter`/`dragleave` fire again for every descendant the pointer
  // crosses, so nesting is tracked with a depth counter — a boolean flickers
  // the moment the drag reaches the first child.
  const depthRef = useRef(0);
  // Latest callback without giving the handlers a new identity each render.
  const onFilesRef = useRef(onFiles);
  useEffect(() => {
    onFilesRef.current = onFiles;
  }, [onFiles]);

  const reset = useCallback(() => {
    depthRef.current = 0;
    setIsDragging(false);
  }, []);

  const onDragEnter = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (!carriesFiles(event.dataTransfer)) return;
    // `dragenter`/`dragover` must be prevented, or the browser never fires
    // `drop` — it shows the "no drop here" cursor instead.
    event.preventDefault();
    depthRef.current += 1;
    setIsDragging(true);
  }, []);

  const onDragOver = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (!carriesFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const onDragLeave = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (!carriesFiles(event.dataTransfer)) return;
    depthRef.current = Math.max(0, depthRef.current - 1);
    if (depthRef.current === 0) setIsDragging(false);
  }, []);

  const onDrop = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      if (!carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      const files = Array.from(event.dataTransfer.files);
      reset();
      if (files.length > 0) onFilesRef.current(files);
    },
    [reset],
  );

  useEffect(() => {
    const swallow = (event: Event) => {
      const dataTransfer = (event as DragEvent).dataTransfer ?? null;
      if (!carriesFiles(dataTransfer)) return;
      event.preventDefault();
      // The drop landed somewhere that is not a zone: nothing was attached,
      // so this only guarantees the tab does not navigate to the file.
      if (event.type === "drop") reset();
    };
    // Leaving the window drops the pointer count without a `dragleave` we can
    // rely on; without this the highlight can outlive the drag.
    const onWindowDragLeave = (event: DragEvent) => {
      if (!event.relatedTarget) reset();
    };

    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    window.addEventListener("dragleave", onWindowDragLeave);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
      window.removeEventListener("dragleave", onWindowDragLeave);
    };
  }, [reset]);

  return { isDragging, dropZoneProps: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}
