"use client";

import { GlassPanel } from "@/components/ui/glass-panel";
import { Paperclip } from "lucide-react";

/**
 * Hint shown over the chat while files are dragged onto it.
 *
 * Purely visual: the drag events are handled by the surface underneath, so it
 * never intercepts the pointer (`pointer-events-none`) and covers exactly the
 * column the drop lands in.
 */
export function FileDropOverlay() {
  return (
    <div
      data-slot="file-drop-overlay"
      className="border-primary/60 bg-background/80 animate-in fade-in pointer-events-none absolute inset-0 z-30 flex items-center justify-center border-2 border-dashed p-4 duration-150"
    >
      {/* The scrim only dims the transcript. the hint needs its own opaque
          surface to stay readable over whatever it covers. */}
      <GlassPanel className="flex flex-col items-center gap-3 rounded-2xl px-6 py-5 text-center">
        <Paperclip className="text-primary h-6 w-6" />
        <p className="text-sm font-medium">Drop files to attach</p>
      </GlassPanel>
    </div>
  );
}
