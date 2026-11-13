"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageTabStrip } from "@/components/layout/page";
import { cn } from "@/lib/utils";

/** The width the panel keeps while it is put away: room for one column of icons. */
export const SESSION_RAIL_WIDTH = 40;

/** One view the panel can show. */
export interface SessionPanelTab {
  id: string;
  /** What the strip says. The file tab puts the file's name here. */
  label: ReactNode;
  /** Beside the label, hidden once the panel is phone-narrow. */
  icon?: ReactNode;
  /** Keep the icon narrow too, for a tab that has nothing else to say. */
  pinIcon?: boolean;
  /** After the label: a count, or the dot for something running. */
  badge?: ReactNode;
  /** Inside the trigger after the label, e.g. a close control. */
  trailing?: ReactNode;
  /** Named on the trigger when the label says little, as for an open file. */
  ariaLabel?: string;
  content: ReactNode;
}

/** What a tab is called once its label is only an icon. */
function railName(tab: SessionPanelTab): string {
  if (tab.ariaLabel) return tab.ariaLabel;
  return typeof tab.label === "string" ? tab.label : tab.id;
}

/**
 * The panel while it is put away: a strip of its tabs, so the edge of it stays
 * on screen and the control that brings it back never moves.
 */
function SessionRail({
  tabs,
  value,
  label,
  onSelect,
}: {
  tabs: SessionPanelTab[];
  /** The tab the panel reopens on. */
  value: string;
  /** The panel's own name, for the control that brings it back. */
  label: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div
      data-slot="session-panel-rail"
      className="animate-in fade-in flex shrink-0 flex-col items-center duration-150 motion-reduce:animate-none"
      style={{ width: SESSION_RAIL_WIDTH }}
    >
      {/* The height of the strip's row, so the panel's first line stays put. */}
      <div className="flex h-[46px] w-full shrink-0 items-center justify-center border-b">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Show the ${label}`}
          title={`Show the ${label}`}
          onClick={() => onSelect(value)}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex flex-col items-center gap-0.5 py-1">
        {tabs.map((tab) => (
          <Button
            key={tab.id}
            variant="ghost"
            size="icon-sm"
            aria-label={railName(tab)}
            title={railName(tab)}
            aria-pressed={tab.id === value}
            className={cn(tab.id === value && "bg-accent/70 text-foreground")}
            onClick={() => onSelect(tab.id)}
          >
            {tab.icon ?? (
              <span className="text-[10px] font-semibold">{railName(tab).slice(0, 1)}</span>
            )}
          </Button>
        ))}
      </div>
    </div>
  );
}

/**
 * The right-hand panel a session shows beside its conversation.
 *
 * The coder chat fills it with its worktree: what changed, what is in the
 * checkout, a shell and the ports it listens on. A plain chat fills the same
 * panel with its workspace and the automations posting into it. One component,
 * so a tab, the strip and the close control read the same in both.
 *
 * A tab is mounted on its first visit and kept after that: leaving the terminal
 * alone must not stop the command running in it. `collapsed` hides the tabs
 * rather than unmounting them, so a shell in the terminal survives the panel
 * being put away.
 */
export function SessionPanel({
  value,
  onValueChange,
  tabs,
  notice,
  className,
  label = "session panel",
  collapsed = false,
  onExpand,
  onCollapse,
}: {
  /** The open tab's id. The caller owns it, so a header button can pick one. */
  value: string;
  onValueChange: (id: string) => void;
  tabs: SessionPanelTab[];
  /** Above the strip: something about the session as a whole. */
  notice?: ReactNode;
  className?: string;
  /** The panel's own name, read on the controls that open and close it. */
  label?: string;
  /** Put the panel away: only its rail shows, and its tabs stay mounted. */
  collapsed?: boolean;
  /** A rail icon was picked, or the rail asked for the panel back. */
  onExpand?: () => void;
  /** The strip's close control. Omit it for a panel that cannot be put away. */
  onCollapse?: () => void;
}) {
  // A tab keeps what was in it while another is shown, and pays nothing until
  // it has been opened once.
  const [visited, setVisited] = useState<string[]>([value]);
  useEffect(() => {
    setVisited((current) => (current.includes(value) ? current : [...current, value]));
  }, [value]);

  const rail = collapsed ? (
    <SessionRail
      tabs={tabs}
      value={value}
      label={label}
      onSelect={(id) => {
        onValueChange(id);
        onExpand?.();
      }}
    />
  ) : null;

  return (
    <GlassPanel
      data-slot="session-panel"
      data-state={collapsed ? "collapsed" : "open"}
      className={cn(
        "flex h-full min-w-0 overflow-hidden",
        collapsed ? "flex-row-reverse" : "flex-col",
        className,
      )}
    >
      {rail}

      {notice && !collapsed ? notice : null}

      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          collapsed
            ? "hidden"
            : "animate-in fade-in slide-in-from-right-1 duration-150 motion-reduce:animate-none",
        )}
        aria-hidden={collapsed ? true : undefined}
      >
        <Tabs
          value={value}
          onValueChange={onValueChange}
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          {/* A container query, because the panel is 280px on a phone sheet and
            720px when dragged wide; the icons only earn their room when it is. */}
          <div className="@container flex items-center gap-1 border-b">
            <PageTabStrip className="min-w-0 flex-1 px-2 py-1.5">
              <TabsList>
                {tabs.map((tab) => (
                  <TabsTrigger
                    key={tab.id}
                    value={tab.id}
                    {...(tab.ariaLabel ? { "aria-label": tab.ariaLabel } : {})}
                    className="gap-1.5 text-xs"
                  >
                    {tab.icon ? (
                      <span className={tab.pinIcon ? "flex" : "hidden @min-[390px]:flex"}>
                        {tab.icon}
                      </span>
                    ) : null}
                    {tab.label}
                    {tab.badge}
                    {tab.trailing}
                  </TabsTrigger>
                ))}
              </TabsList>
            </PageTabStrip>
            {onCollapse && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="mr-1.5 shrink-0"
                aria-label={`Hide the ${label}`}
                title={`Hide the ${label}`}
                onClick={onCollapse}
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>

          {tabs.map((tab) => (
            <TabsContent
              key={tab.id}
              value={tab.id}
              keepMounted={visited.includes(tab.id)}
              className="flex min-h-0 flex-1 flex-col overflow-hidden"
            >
              {tab.content}
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </GlassPanel>
  );
}

/**
 * The panel as a phone sees it: a sheet over the conversation, because a column
 * beside the transcript leaves neither of them enough room there.
 *
 * The sheet carries the close control, so the panel inside needs none; the
 * coder chat and the plain chat both arrive this way.
 */
export function SessionPanelSheet({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Read out for the sheet's own name; the panel's tabs name the content. */
  title: string;
  children: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-4/5 max-w-[380px] p-0">
        <SheetHeader className="sr-only">
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>
        <div className="h-full">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
