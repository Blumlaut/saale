"use client";

import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { ToolCategory } from "@/lib/pi/tool-categories";

interface ToolCategoryRowProps {
  category: ToolCategory;
  /** The switch or switches that enable the category, one per scope. */
  controls: React.ReactNode;
  /** Room for a control after the switches, e.g. the settings page's expand chevron. */
  trailing?: React.ReactNode;
  className?: string;
}

/** One tool category: its icon, what it covers, and the switches that enable it. */
export function ToolCategoryRow({ category, controls, trailing, className }: ToolCategoryRowProps) {
  const Icon = category.icon;

  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-3 py-3", className)}>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Icon className="text-muted-foreground h-4 w-4 shrink-0" />
        <div className="min-w-0 space-y-0.5">
          <Label className="text-sm font-medium">{category.label}</Label>
          <p className="text-muted-foreground text-xs">{category.description}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {controls}
        {trailing}
      </div>
    </div>
  );
}
