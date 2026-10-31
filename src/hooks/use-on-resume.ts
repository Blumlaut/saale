"use client";

import { useEffect, useRef } from "react";

/**
 * A page hidden this long was suspended, not switched away from and back.
 * Phones freeze an installed app within seconds of minimizing it; a desktop
 * tab switch is usually shorter.
 */
export const SUSPENSION_MIN_HIDDEN_MS = 5_000;

/**
 * Run `callback` when the page becomes visible again.
 *
 * Everything a page holds open across a suspension comes back stale: sockets
 * look connected without delivering, timers carry the time they lost. The
 * callback is told how long the page was hidden so it can tell a suspension
 * apart from a tab switch.
 */
export function useOnResume(callback: (hiddenForMs: number) => void): void {
  // Fresh callback without resubscribing on every render.
  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  });

  useEffect(() => {
    let hiddenSince: number | null = null;

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenSince = Date.now();
        return;
      }
      const hiddenForMs = hiddenSince === null ? 0 : Date.now() - hiddenSince;
      hiddenSince = null;
      callbackRef.current(hiddenForMs);
    };

    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
}
