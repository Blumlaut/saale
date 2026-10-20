"use client";

import { useCallback, useEffect, useRef } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";

/** How long a press has to be held before it turns into a selection. */
export const LONG_PRESS_MS = 500;

/** Movement (px) that turns a press into a scroll/drag and drops the hold. */
const MOVE_TOLERANCE_PX = 10;

export interface LongPressHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  /** The gesture that just ended was a hold. Consumes the flag. call it once, first thing in `onClick`. */
  consumeLongPress: () => boolean;
}

/**
 * Press-and-hold gesture for touch (and pen) rows.
 *
 * Pointer events cover mouse, touch and pen with one code path. The hold is
 * dropped when the finger moves. that is a scroll, not a selection. and the
 * browser's own long-press menu is suppressed on touch so it cannot cover the
 * list that is being selected.
 */
export function useLongPress(onLongPress: () => void): LongPressHandlers {
  const handlerRef = useRef(onLongPress);
  const timerRef = useRef<number | null>(null);
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const touchRef = useRef(false);
  const heldRef = useRef(false);

  // Read the latest handler when the timer fires, not the one from the render
  // that started the press. a re-render in between must not replay stale state.
  useEffect(() => {
    handlerRef.current = onLongPress;
  });

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    originRef.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return; // secondary button is the context menu
    cancel();
    heldRef.current = false;
    touchRef.current = event.pointerType !== "mouse";
    originRef.current = { x: event.clientX, y: event.clientY };
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      heldRef.current = true;
      // Text selected on the way here would sit behind the new selection UI.
      window.getSelection()?.removeAllRanges();
      handlerRef.current();
    }, LONG_PRESS_MS);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const origin = originRef.current;
    if (timerRef.current === null || !origin) return;
    const dx = event.clientX - origin.x;
    const dy = event.clientY - origin.y;
    if (dx * dx + dy * dy > MOVE_TOLERANCE_PX * MOVE_TOLERANCE_PX) cancel();
  };

  const onContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    // Android fires this halfway into a touch hold, on top of the row.
    if (touchRef.current) event.preventDefault();
  };

  const consumeLongPress = () => {
    if (!heldRef.current) return false;
    heldRef.current = false;
    return true;
  };

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu,
    consumeLongPress,
  };
}
