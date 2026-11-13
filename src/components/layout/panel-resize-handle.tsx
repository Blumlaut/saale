"use client";

import { cn } from "@/lib/utils";
import type { ResizableWidth } from "@/hooks/use-resizable-width";

/**
 * The grip that sets a column's width.
 *
 * `edge` sits inside a panel and covers its own edge (a sidebar's right side).
 * `gutter` is a sibling between two columns, which is what a panel dragged out
 * of the page needs. Both carry the separator role the hook exposes, so the
 * keyboard reaches the same resize.
 */
export function PanelResizeHandle({
  handle,
  dragging = false,
  placement = "gutter",
  className,
}: {
  handle: ResizableWidth["handleProps"];
  dragging?: boolean;
  placement?: "edge" | "gutter";
  className?: string;
}) {
  return (
    <div
      {...handle}
      className={cn(
        placement === "edge"
          ? "hover:bg-border absolute top-0 right-0 z-10 h-full w-1.5 cursor-col-resize"
          : "group hover:bg-border focus-visible:ring-ring mx-1 w-1.5 shrink-0 cursor-col-resize touch-none items-center justify-center rounded-full transition-colors focus-visible:ring-2 focus-visible:outline-none",
        dragging && placement === "gutter" && "bg-border",
        className,
      )}
    />
  );
}
