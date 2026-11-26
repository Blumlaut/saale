import { useEffect, type RefObject } from "react";

/**
 * Call `handler` when a click occurs outside the referenced elements.
 *
 * A portalled panel is still part of the thing it belongs to: pass its ref
 * alongside, or the mousedown inside it closes the panel before its own click
 * handler runs.
 */
export function useClickOutside(
  refs: RefObject<HTMLElement | null> | ReadonlyArray<RefObject<HTMLElement | null>>,
  handler: () => void,
): void {
  useEffect(() => {
    const elements = Array.isArray(refs) ? refs : [refs];
    const handleClick = (e: MouseEvent) => {
      const inside = elements.some((ref) => ref.current?.contains(e.target as Node));
      if (!inside) handler();
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [refs, handler]);
}
