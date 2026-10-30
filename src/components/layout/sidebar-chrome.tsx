"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { useResizableWidth } from "@/hooks/use-resizable-width";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { ChangelogSheet } from "@/components/layout/changelog-sheet";
import { ChevronDown, ChevronRight, Moon, Sun, type LucideIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { useColorMode } from "@/hooks/use-color-mode";
import { APP_VERSION } from "@/lib/version";

/**
 * The one sidebar. Both the dashboard and the admin panel render their items
 * through these parts, so the frame, the item states and the footer cannot
 * drift apart.
 */

/** A nav row. Active gets the accent fill and the orange edge bar. */
export function sidebarItemClass(active: boolean, extra = "") {
  return cn(
    "relative flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors duration-150",
    active
      ? "bg-accent text-foreground font-medium before:absolute before:left-0 before:top-1/2 before:h-5 before:w-[3px] before:-translate-y-1/2 before:rounded-full before:bg-primary"
      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
    extra,
  );
}

/** A nested page under a nav row. Same shape and states, indented. */
export function sidebarSectionItemClass(active: boolean) {
  return cn(
    "relative flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors duration-150",
    active
      ? "bg-accent text-foreground font-medium before:absolute before:top-1/2 before:left-0 before:h-4 before:w-[3px] before:-translate-y-1/2 before:rounded-full before:bg-primary"
      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
  );
}

export interface SidebarSection {
  id: string;
  href: string;
  label: string;
}

export interface SidebarSectionGroup {
  /** Group heading; the dashboard settings sections come in four of them. */
  label: string | null;
  items: readonly SidebarSection[];
}

/** The panel a sidebar lives in, with its drag handle. */
export function SidebarFrame({ children }: { children: React.ReactNode }) {
  const width = useResizableWidth({
    storageKey: "saale:ui:nav:width",
    label: "Resize navigation",
    defaultWidth: 192,
    minWidth: 160,
    maxWidth: 320,
    handle: "right",
  });

  return (
    <nav
      className="sidebar-nav relative sticky top-6 max-h-[calc(100dvh-3rem)] shrink-0 overflow-y-auto"
      style={{ width: width.width }}
    >
      <GlassPanel className="shadow-md">
        <div
          {...width.handleProps}
          className="hover:bg-border absolute top-0 right-0 z-10 h-full w-1.5 cursor-col-resize"
        />
        <GlassPanelContent className="p-3">{children}</GlassPanelContent>
      </GlassPanel>
    </nav>
  );
}

/** Wordmark, an optional area badge, and the notification bell. */
export function SidebarBrand({ badge }: { badge?: string }) {
  return (
    <>
      <div className="mb-1 flex items-center justify-between px-3 py-2">
        <Link href="/dashboard/chat" className="flex items-center gap-2">
          <ChevronRight className="text-primary h-5 w-5" />
          <span className="text-lg font-bold tracking-tight">Saale</span>
        </Link>
        <span className="flex items-center gap-1.5">
          {badge ? (
            <span className="text-muted-foreground bg-muted rounded-full px-2 py-0.5 text-[10px] font-medium">
              {badge}
            </span>
          ) : null}
          <NotificationBell />
        </span>
      </div>
      <Separator className="my-2" />
    </>
  );
}

/** A top-level item, with an optional control beside it (the section toggle). */
export function SidebarItem({
  href,
  label,
  icon: Icon,
  active,
  trailing,
  rowRef,
}: {
  href: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  trailing?: React.ReactNode;
  /** Lets `useRowFlip` measure the row, so a reorder can slide it. */
  rowRef?: (element: HTMLDivElement | null) => void;
}) {
  return (
    <div ref={rowRef} className="flex items-center gap-1">
      <Link href={href} className={sidebarItemClass(active, "min-w-0 flex-1")}>
        <Icon className="h-4 w-4 shrink-0" />
        <span className="truncate">{label}</span>
      </Link>
      {trailing}
    </div>
  );
}

/** Opens and closes a row's pages. */
export function SidebarSectionToggle({
  label,
  expanded,
  onToggle,
}: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="text-muted-foreground size-7 shrink-0 rounded-md"
      aria-expanded={expanded}
      aria-label={expanded ? `Hide ${label} pages` : `Show ${label} pages`}
      onClick={onToggle}
    >
      <ChevronDown
        className={cn("h-3.5 w-3.5 transition-transform duration-150", !expanded && "-rotate-90")}
      />
    </Button>
  );
}

/**
 * The drawer a nav row's pages slide out of. Kept mounted so opening and
 * closing animate; `inert` keeps the hidden links out of the tab order.
 */
export function SidebarSections({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
      )}
    >
      <div className="overflow-hidden" inert={!open}>
        <div className="mt-0.5 ml-3 pb-1">{children}</div>
      </div>
    </div>
  );
}

/** The pages of one nav row, nested under it. */
export function SidebarSectionList({
  groups,
  activeId,
}: {
  groups: readonly SidebarSectionGroup[];
  activeId?: string | undefined;
}) {
  return (
    <>
      {groups.map((group, index) => (
        <div
          key={group.label ?? index}
          className={index > 0 ? "border-border/60 border-t pt-1" : undefined}
        >
          {group.items.map((section) => (
            <Link
              key={section.id}
              href={section.href}
              aria-current={activeId === section.id ? "page" : undefined}
              className={sidebarSectionItemClass(activeId === section.id)}
            >
              <span className="truncate">{section.label}</span>
            </Link>
          ))}
        </div>
      ))}
    </>
  );
}

/**
 * Slides rows to their new places when their order changes, which is what makes
 * a reorder in the appearance editor readable on the sidebar itself. Positions
 * are only compared when the order is different, so expanding a section does
 * not set every row in motion.
 */
export function useRowFlip(order: readonly string[]) {
  const rows = useRef(new Map<string, HTMLElement>());
  const registry = useRef(new Map<string, (element: HTMLElement | null) => void>());
  const before = useRef(new Map<string, number>());
  const previousOrder = useRef("");

  const rowRef = useCallback((id: string) => {
    const existing = registry.current.get(id);
    if (existing) return existing;

    const ref = (element: HTMLElement | null) => {
      if (element) rows.current.set(id, element);
      else rows.current.delete(id);
    };
    registry.current.set(id, ref);
    return ref;
  }, []);

  useLayoutEffect(() => {
    const tops = new Map<string, number>();
    for (const [id, element] of rows.current) {
      tops.set(id, element.getBoundingClientRect().top);
    }

    const signature = order.join(",");
    const reordered = previousOrder.current !== "" && previousOrder.current !== signature;
    previousOrder.current = signature;

    if (reordered && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      for (const [id, element] of rows.current) {
        const from = before.current.get(id);
        const to = tops.get(id);
        if (from === undefined || to === undefined) continue;

        const shift = from - to;
        if (Math.abs(shift) < 1) continue;
        element.animate([{ transform: `translateY(${shift}px)` }, { transform: "translateY(0)" }], {
          duration: 180,
          easing: "cubic-bezier(0.2, 0, 0, 1)",
        });
      }
    }

    before.current = tops;
  });

  return rowRef;
}

/** Console footer: version, theme toggle, orange tick. */
export function SidebarFooter() {
  const { setTheme } = useTheme();
  const mode = useColorMode();
  const [changelogOpen, setChangelogOpen] = useState(false);

  return (
    <div className="border-border/60 mt-4 border-t px-3 pt-3">
      <div className="flex items-center justify-between">
        <Button
          variant="ghost"
          className="console-label hover:text-foreground -ml-1.5 h-6 px-1.5 font-semibold"
          onClick={() => setChangelogOpen(true)}
          title="Changelog"
          aria-label={`Saale ${APP_VERSION}, changelog`}
        >
          Saale{" "}
          <span className="text-muted-foreground/70 tracking-normal normal-case">
            {APP_VERSION}
          </span>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 rounded-md"
          onClick={() => setTheme(mode === "dark" ? "light" : "dark")}
          aria-label="Toggle theme"
        >
          <Sun className="h-3.5 w-3.5 dark:hidden" />
          <Moon className="hidden h-3.5 w-3.5 dark:block" />
        </Button>
      </div>
      <div className="bg-primary mt-2 h-0.5 w-8 rounded-full" />
      <ChangelogSheet open={changelogOpen} onOpenChange={setChangelogOpen} />
    </div>
  );
}
