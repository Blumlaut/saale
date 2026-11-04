"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * A box's content width, null until it has been measured.
 *
 * For a column whose limits follow the room it sits in: the observer reports
 * every resize, so the limit follows a window drag as well.
 */
export function useElementWidth(): [(node: HTMLElement | null) => void, number | null] {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  const measure = useCallback((node: HTMLElement | null) => setElement(node), []);

  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next !== undefined) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return [measure, width];
}
