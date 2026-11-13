"use client";

import { useEffect, useState, type ReactNode } from "react";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageTabStrip } from "@/components/layout/page";
import { cn } from "@/lib/utils";

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

/**
 * The right-hand panel a session shows beside its conversation.
 *
 * The coder chat fills it with its worktree: what changed, what is in the
 * checkout, a shell and the ports it listens on. A plain chat fills the same
 * panel with its workspace and the automations posting into it. One component,
 * so a tab, the strip and the close control read the same in both.
 *
 * A tab is mounted on its first visit and kept after that: leaving the terminal
 * alone must not stop the command running in it.
 */
export function SessionPanel({
  value,
  onValueChange,
  tabs,
  notice,
  className,
}: {
  /** The open tab's id. The caller owns it, so a header button can pick one. */
  value: string;
  onValueChange: (id: string) => void;
  tabs: SessionPanelTab[];
  /** Above the strip: something about the session as a whole. */
  notice?: ReactNode;
  className?: string;
}) {
  // A tab keeps what was in it while another is shown, and pays nothing until
  // it has been opened once.
  const [visited, setVisited] = useState<string[]>([value]);
  useEffect(() => {
    setVisited((current) => (current.includes(value) ? current : [...current, value]));
  }, [value]);

  return (
    <GlassPanel
      data-slot="session-panel"
      className={cn("flex h-full min-w-0 flex-col overflow-hidden", className)}
    >
      {notice}

      <Tabs
        value={value}
        onValueChange={onValueChange}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        {/* A container query, because the panel is 280px on a phone sheet and
            720px when dragged wide; the icons only earn their room when it is. */}
        <PageTabStrip className="@container border-b px-2 py-1.5">
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
