"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { useResizableWidth } from "@/hooks/use-resizable-width";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { ChevronDown, ChevronRight, Moon, Sun, type LucideIcon } from "lucide-react";
import { useTheme } from "next-themes";

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

/** A nested page under a nav row. Same shape, tighter. */
export function sidebarSectionItemClass(active: boolean) {
  return cn(
    "flex items-center rounded-lg px-2 py-0.5 text-sm transition-colors duration-150",
    active
      ? "bg-accent text-foreground font-medium"
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
      className="sidebar-nav no-scrollbar relative sticky top-6 max-h-[calc(100dvh-3rem)] shrink-0 overflow-y-auto"
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
}: {
  href: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1">
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

/** The pages of one nav row, nested under it. */
export function SidebarSectionList({
  groups,
  activeId,
}: {
  groups: readonly SidebarSectionGroup[];
  activeId?: string | undefined;
}) {
  return (
    <div className="border-border/60 mt-1 ml-3.5 border-l pl-1.5">
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
    </div>
  );
}

/** Console footer: version, theme toggle, orange tick. */
export function SidebarFooter() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="border-border/60 mt-4 border-t px-3 pt-3">
      <div className="flex items-center justify-between">
        <p className="console-label">
          Saale{" "}
          <span className="text-muted-foreground/70 font-mono tracking-normal normal-case">
            v0.1.0
          </span>
        </p>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 rounded-md"
          onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          aria-label="Toggle theme"
        >
          <Sun className="h-3.5 w-3.5 dark:hidden" />
          <Moon className="hidden h-3.5 w-3.5 dark:block" />
        </Button>
      </div>
      <div className="bg-primary mt-2 h-0.5 w-8 rounded-full" />
    </div>
  );
}
