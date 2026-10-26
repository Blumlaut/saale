"use client";

import { AlertTriangle, Activity } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PluginStatusData, PluginWidgetData } from "./types";

/**
 * A plugin is waiting on the user.
 *
 * The dialog is open while one is pending; dismissing it leaves this row, so a
 * blocked run is never invisible. The chat is the only place it appears. a
 * dialog opened in another chat reaches that chat's stream and nothing else.
 */
export function PluginInteractionBar({ count, onReview }: { count: number; onReview: () => void }) {
  if (count === 0) return null;
  return (
    <div className="border-border flex items-center gap-2 border-t px-4 py-2 md:px-6">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-yellow-600 dark:text-yellow-500" />
      <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
        {count === 1 ? "A plugin needs your input" : `${count} plugin prompts need your input`}
      </span>
      <Button size="sm" variant="secondary" className="h-7 shrink-0" onClick={onReview}>
        Review
      </Button>
    </div>
  );
}

/** The status lines plugins set, in the order they were first set. */
export function PluginStatusStrip({ statuses }: { statuses: PluginStatusData[] }) {
  if (statuses.length === 0) return null;
  return (
    <div className="border-border text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-4 py-1.5 font-mono text-[11px] md:px-6">
      <Activity className="h-3 w-3 shrink-0" />
      {statuses.map((status) => (
        <span key={status.key} className="min-w-0 truncate">
          {status.text}
        </span>
      ))}
    </div>
  );
}

/**
 * A panel a plugin put above or below the composer.
 *
 * Pi hands over plain lines here (a terminal component cannot cross into the
 * browser), so the panel is a mono block that scrolls on its own.
 */
export function PluginWidgetPanel({
  widgets,
  placement,
}: {
  widgets: PluginWidgetData[];
  placement: PluginWidgetData["placement"];
}) {
  const shown = widgets.filter((widget) => widget.placement === placement && widget.lines?.length);
  if (shown.length === 0) return null;
  return (
    <div className={cn("border-border flex flex-col gap-1 border-t px-4 py-2 md:px-6")}>
      {shown.map((widget) => (
        <pre
          key={widget.key}
          className="text-muted-foreground max-h-24 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap"
        >
          {widget.lines?.join("\n")}
        </pre>
      ))}
    </div>
  );
}
