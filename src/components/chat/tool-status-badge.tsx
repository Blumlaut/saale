"use client";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { CheckCircle, AlertCircle, Loader2 } from "lucide-react";
import type { ToolStatus, ToolStatusTone } from "./tool-status";

/** Badge tone per status. the only place a tool status is coloured. */
const TONE_CLASS: Record<ToolStatusTone, string> = {
  running: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400",
  success: "bg-green-500/10 text-green-600 dark:text-green-400",
  danger: "bg-red-500/10 text-red-600 dark:text-red-400",
};

const TONE_ICON: Record<ToolStatusTone, typeof CheckCircle> = {
  running: Loader2,
  success: CheckCircle,
  danger: AlertCircle,
};

/**
 * The status badge every tool card shares, plus the share page's redacted card.
 *
 * Kept out of the card shell so the redacted card. which renders no card at
 * all, only a name and a summary. can use the same badge without pulling in
 * the transcript's renderer.
 */
export function ToolStatusBadge({ status }: { status: ToolStatus }) {
  const Icon = TONE_ICON[status.tone];

  return (
    <Badge
      variant="secondary"
      className={cn(
        "ml-auto shrink-0 rounded-full px-1.5 py-0 text-[10px]",
        TONE_CLASS[status.tone],
      )}
    >
      <Icon className={cn("mr-1 h-2.5 w-2.5", status.tone === "running" && "animate-spin")} />
      {status.label}
    </Badge>
  );
}
