"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

export interface ResizableWidthOptions {
  /** Where the width is remembered between visits. */
  storageKey: string;
  /** What the handle is called for a screen reader. */
  label: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  /**
   * The edge of the panel the handle sits on. A handle on the panel's left edge
   * grows it as it is pulled left, so the pointer delta is inverted for it.
   */
  handle: "left" | "right";
}

export interface ResizableWidth {
  width: number;
  /** True while the handle is held, so the page can drop its transitions. */
  dragging: boolean;
  handleProps: {
    role: "separator";
    "aria-orientation": "vertical";
    "aria-label": string;
    "aria-valuenow": number;
    "aria-valuemin": number;
    "aria-valuemax": number;
    tabIndex: 0;
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  };
}

/** How far one arrow key moves the edge. */
const KEYBOARD_STEP_PX = 24;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readStoredWidth(key: string, fallback: number): number {
  try {
    const stored = Number(window.localStorage.getItem(key));
    return Number.isFinite(stored) && stored > 0 ? stored : fallback;
  } catch (err) {
    console.error(`Failed to read the panel width from ${key}:`, err);
    return fallback;
  }
}

function writeStoredWidth(key: string, width: number): void {
  try {
    window.localStorage.setItem(key, String(width));
  } catch (err) {
    // A full or disabled store only costs the next visit its width.
    console.error(`Failed to keep the panel width in ${key}:`, err);
  }
}

/**
 * A drag handle that sets one column's width.
 *
 * Pointer capture keeps the drag alive when the pointer leaves the handle and
 * travels past the panel, and the caller's `touch-action: none` stops a phone
 * from scrolling the page instead of resizing.
 */
export function useResizableWidth(options: ResizableWidthOptions): ResizableWidth {
  const { storageKey, label, defaultWidth, minWidth, maxWidth, handle } = options;
  const [width, setWidth] = useState(defaultWidth);
  const [dragging, setDragging] = useState(false);
  const current = useRef(defaultWidth);
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  const apply = useCallback(
    (next: number) => {
      const clamped = clamp(next, minWidth, maxWidth);
      current.current = clamped;
      setWidth(clamped);
      return clamped;
    },
    [minWidth, maxWidth],
  );

  // The stored width is read after mount: the server has no localStorage, and
  // painting a different width there would hydrate the column at the wrong size.
  useEffect(() => {
    apply(readStoredWidth(storageKey, defaultWidth));
  }, [storageKey, defaultWidth, apply]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: current.current,
    };
    setDragging(true);
  }, []);

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const active = drag.current;
      if (!active || active.pointerId !== event.pointerId) return;
      const delta = event.clientX - active.startX;
      // A left-edge handle belongs to a right-hand panel: pulling it left widens
      // the panel, because its own left edge is what moves.
      apply(active.startWidth + (handle === "left" ? -delta : delta));
    },
    [apply, handle],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const active = drag.current;
      if (!active || active.pointerId !== event.pointerId) return;
      drag.current = null;
      setDragging(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      writeStoredWidth(storageKey, current.current);
    },
    [storageKey],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      // The key names the direction the edge travels, so ArrowLeft widens a
      // panel whose handle is on its left edge.
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const next = apply(
        current.current + KEYBOARD_STEP_PX * direction * (handle === "left" ? -1 : 1),
      );
      writeStoredWidth(storageKey, next);
      event.preventDefault();
    },
    [apply, handle, storageKey],
  );

  return {
    width,
    dragging,
    handleProps: {
      role: "separator",
      "aria-orientation": "vertical",
      "aria-label": label,
      "aria-valuenow": Math.round(width),
      "aria-valuemin": minWidth,
      "aria-valuemax": maxWidth,
      tabIndex: 0,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onKeyDown,
    },
  };
}
