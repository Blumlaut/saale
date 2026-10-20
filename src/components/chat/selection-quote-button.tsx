"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { TextQuote } from "lucide-react";
import { cn } from "@/lib/utils";

interface SelectionQuoteButtonProps {
  /** Scrollable message-list container the button floats over. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  onQuote: (text: string) => void;
  /** Changes when the message list re-renders its content (streaming,
      reloads) so the button can re-check a possibly stale selection. */
  version: number;
}

interface SelectionState {
  text: string;
  /** Selection bounds relative to the container's *visible viewport*. The
      button is a sibling of the scroller, pinned to the non-scrolling
      wrapper, so these are viewport offsets. adding `scrollTop` here would
      push the button off the panel in any scrolled transcript. */
  top: number;
  bottom: number;
  centerX: number;
  /** The container's visible height, to clamp the placement on screen. */
  viewportHeight: number;
}

const GAP = 6;
// Button height (size="xs" → h-6): decides above- vs. below-placement.
const BUTTON_HEIGHT = 24;
// Approximate half-width of the button, used to clamp the center X so the
// pill never hangs off the container edge.
const HALF_WIDTH = 44;

function elementOf(node: Node): Element | null {
  if (node.nodeType === Node.TEXT_NODE) return node.parentElement;
  return node instanceof Element ? node : null;
}

export function SelectionQuoteButton({
  containerRef,
  onQuote,
  version,
}: SelectionQuoteButtonProps) {
  const [selection, setSelection] = useState<SelectionState | null>(null);
  // Last position a selection produced. While the button fades out after the
  // selection is cleared it must stay where it was. jumping to the corner
  // during the opacity transition would flash it on screen.
  const [lastPos, setLastPos] = useState<SelectionState | null>(null);

  const update = useCallback(() => {
    const container = containerRef.current;
    const sel = window.getSelection();
    if (!container || !sel || sel.rangeCount === 0) {
      setSelection(null);
      return;
    }
    const range = sel.getRangeAt(0);
    if (range.collapsed) {
      setSelection(null);
      return;
    }
    const text = sel.toString().trim();
    if (!text) {
      setSelection(null);
      return;
    }
    // Only selections fully inside quoteable bubbles count. otherwise the
    // captured text would mix message content with timestamps, avatars, or
    // the neighbouring bubble.
    const startEl = elementOf(range.startContainer);
    const endEl = elementOf(range.endContainer);
    if (!startEl?.closest("[data-quoteable]") || !endEl?.closest("[data-quoteable]")) {
      setSelection(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    const bounds = container.getBoundingClientRect();
    const next: SelectionState = {
      text,
      top: rect.top - bounds.top,
      bottom: rect.bottom - bounds.top,
      centerX: rect.left + rect.width / 2 - bounds.left,
      viewportHeight: container.clientHeight,
    };
    setLastPos(next);
    setSelection(next);
  }, [containerRef]);

  // Fires on every drag step, touch selection, and programmatic change.
  useEffect(() => {
    document.addEventListener("selectionchange", update);
    const container = containerRef.current;
    // Scrolling desyncs the stored position from the selection. hide and
    // let the next selection bring the button back.
    const onScroll = () => setSelection(null);
    container?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      document.removeEventListener("selectionchange", update);
      container?.removeEventListener("scroll", onScroll);
    };
  }, [containerRef, update]);

  // Re-check after the transcript re-renders (streaming tokens, DB reloads):
  // a live selection gets repositioned, a collapsed one hides the button.
  useEffect(() => {
    update();
  }, [version, update]);

  const quote = useCallback(() => {
    if (!selection) return;
    onQuote(selection.text);
  }, [selection, onQuote]);

  // ⌘/Ctrl+Shift+Q. only while a valid selection is on screen (a selection
  // inside the composer textarea never registers, so it can't collide).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!selection) return;
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.key.toLowerCase() !== "q") return;
      e.preventDefault();
      quote();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selection, quote]);

  // While hidden, the button keeps the last selection's position so the
  // fade-out happens in place instead of from the corner.
  const pos = selection ?? lastPos;
  // Above the selection by default; below when there is no room above. The
  // wrapper does not scroll, so anything past its visible edge is clipped
  // clamp the placement into the container's viewport.
  const placeAbove = pos !== null && pos.top - GAP - BUTTON_HEIGHT >= 4;
  let top = pos === null ? 0 : placeAbove ? pos.top - GAP - BUTTON_HEIGHT : pos.bottom + GAP;
  if (pos !== null && pos.viewportHeight > BUTTON_HEIGHT) {
    top = Math.min(Math.max(top, 0), pos.viewportHeight - BUTTON_HEIGHT);
  }

  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      aria-label="Quote selection into your reply"
      aria-hidden={selection ? undefined : true}
      tabIndex={selection ? 0 : -1}
      title="Quote selection (⌘/Ctrl+Shift+Q)"
      // Prevent the click from stealing focus. that would collapse the
      // selection before onQuote could read it (kept in state, but still).
      onMouseDown={(e) => e.preventDefault()}
      onClick={quote}
      className={cn(
        "liquid-glass absolute z-10 -translate-x-1/2 whitespace-nowrap transition-opacity",
        selection ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
      )}
      style={
        pos
          ? {
              top,
              left: `clamp(${HALF_WIDTH}px, ${pos.centerX}px, calc(100% - ${HALF_WIDTH}px))`,
            }
          : { top: 0, left: 0 }
      }
    >
      <TextQuote className="h-3 w-3" />
      Quote
    </Button>
  );
}
