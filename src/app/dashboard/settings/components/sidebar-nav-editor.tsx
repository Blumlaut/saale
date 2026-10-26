"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { SIDEBAR_NAV_ICONS } from "@/components/layout/sidebar-nav-icons";
import {
  isDefaultSidebarNav,
  isSidebarNavPinned,
  moveSidebarNavEntry,
  sidebarNavItem,
  type SidebarNavEntry,
  type SidebarNavItemId,
} from "@/lib/navigation/sidebar-nav";
import { ArrowDown, ArrowUp, GripVertical, LayoutList, Loader2, RotateCcw } from "lucide-react";

interface SidebarNavEditorProps {
  /** Current layout, in display order. */
  entries: SidebarNavEntry[];
  saving: boolean;
  error: string | null;
  /** Called with the new layout. persists immediately. */
  onChange: (entries: SidebarNavEntry[]) => void;
  onReset: () => void;
}

/**
 * Reorders and hides dashboard nav items. Edits apply as they are made: the
 * sidebar itself updates the moment a row is toggled or dropped.
 */
export function SidebarNavEditor({
  entries,
  saving,
  error,
  onChange,
  onReset,
}: SidebarNavEditorProps) {
  // Held locally so a drag can preview the new order; committed on drop.
  const [draft, setDraft] = useState(entries);
  const [draggingId, setDraggingId] = useState<SidebarNavItemId | null>(null);

  useEffect(() => setDraft(entries), [entries]);

  /*
   * Rows animate to their new places: the order lives in state, so without a
   * before/after measurement a reorder would just teleport.
   */
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const rowsBefore = useRef(new Map<string, number>());

  const captureRows = useCallback(() => {
    rowsBefore.current = new Map(
      [...rowRefs.current].map(([id, element]) => [id, element.getBoundingClientRect().top]),
    );
  }, []);

  useLayoutEffect(() => {
    const before = rowsBefore.current;
    rowsBefore.current = new Map();
    if (before.size === 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    for (const [id, element] of rowRefs.current) {
      const top = before.get(id);
      if (top === undefined) continue;
      const shift = top - element.getBoundingClientRect().top;
      if (Math.abs(shift) < 1) continue;

      element.animate([{ transform: `translateY(${shift}px)` }, { transform: "translateY(0)" }], {
        duration: 200,
        easing: "cubic-bezier(0.2, 0, 0, 1)",
      });
    }
  }, [draft]);

  const customized = !isDefaultSidebarNav(entries);
  // Pinned items (Settings) are always visible, so the "last visible" guard only
  // counts the items a user can actually hide.
  const visibleNonPinnedCount = draft.filter(
    (entry) => !entry.hidden && !isSidebarNavPinned(entry.id),
  ).length;

  const commit = (next: SidebarNavEntry[]) => {
    captureRows();
    setDraft(next);
    onChange(next);
  };

  const move = (index: number, offset: number) => {
    commit(moveSidebarNavEntry(draft, index, index + offset));
  };

  const setHidden = (id: SidebarNavItemId, hidden: boolean) => {
    commit(draft.map((entry) => (entry.id === id ? { ...entry, hidden } : entry)));
  };

  const handleDragOver = (event: React.DragEvent, id: SidebarNavItemId) => {
    event.preventDefault();
    if (!draggingId || draggingId === id) return;

    /*
     * No slide animation while dragging. The browser picks the drop target from
     * the row under the pointer, so a row sliding under it re-targets itself and
     * the list trades places back and forth.
     */
    setDraft((prev) => {
      const from = prev.findIndex((entry) => entry.id === draggingId);
      const to = prev.findIndex((entry) => entry.id === id);
      return from === -1 || to === -1 ? prev : moveSidebarNavEntry(prev, from, to);
    });
  };

  const handleDragEnd = () => {
    setDraggingId(null);
    // Only persist when the drag actually changed something.
    const moved =
      draft.length === entries.length && draft.some((entry, i) => entry.id !== entries[i]?.id);
    if (moved) onChange(draft);
  };

  return (
    <GlassPanel>
      <GlassPanelContent className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="flex items-center gap-2 text-lg font-medium">
              <LayoutList className="h-5 w-5" />
              Sidebar
            </h3>
            <p className="text-muted-foreground mt-1 text-sm">
              Drag to reorder, or hide the items you don&apos;t use.
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 gap-2"
            onClick={onReset}
            disabled={!customized || saving}
            aria-label="Reset"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCcw className="h-3.5 w-3.5" />
            )}
            <span className="hidden sm:inline">Reset</span>
          </Button>
        </div>

        {error && <p className="text-destructive text-sm">{error}</p>}

        <div className="space-y-1">
          {draft.map((entry, index) => {
            const item = sidebarNavItem(entry.id);
            const Icon = SIDEBAR_NAV_ICONS[entry.id];
            const isPinned = isSidebarNavPinned(entry.id);
            const isLastVisible = !entry.hidden && !isPinned && visibleNonPinnedCount === 1;

            return (
              <Fragment key={entry.id}>
                <div
                  ref={(element) => {
                    if (element) rowRefs.current.set(entry.id, element);
                    else rowRefs.current.delete(entry.id);
                  }}
                  draggable
                  onDragStart={() => setDraggingId(entry.id)}
                  onDragOver={(event) => handleDragOver(event, entry.id)}
                  onDragEnd={handleDragEnd}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-2 py-1.5 transition-[background-color,opacity] duration-200",
                    "hover:bg-accent/60",
                    draggingId === entry.id && "bg-accent/60 opacity-60",
                    entry.hidden && "opacity-40",
                  )}
                >
                  <GripVertical className="text-muted-foreground/50 hidden h-4 w-4 shrink-0 cursor-grab active:cursor-grabbing md:block" />
                  <Icon className="text-muted-foreground h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>

                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0"
                    onClick={() => move(index, -1)}
                    disabled={index === 0}
                    aria-label={`Move ${item.label} up`}
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0"
                    onClick={() => move(index, 1)}
                    disabled={index === draft.length - 1}
                    aria-label={`Move ${item.label} down`}
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </Button>

                  <Switch
                    checked={!entry.hidden}
                    disabled={isPinned || isLastVisible}
                    onCheckedChange={(checked) => setHidden(entry.id, !checked)}
                    aria-label={`Show ${item.label} in the sidebar`}
                    title={
                      isPinned
                        ? "Settings can't be hidden. it's the only place this layout is edited"
                        : isLastVisible
                          ? "At least one sidebar item must stay visible"
                          : undefined
                    }
                  />
                </div>
                {index < draft.length - 1 && <Separator className="my-0.5 opacity-50" />}
              </Fragment>
            );
          })}
        </div>
      </GlassPanelContent>
    </GlassPanel>
  );
}
