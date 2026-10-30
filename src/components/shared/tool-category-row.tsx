"use client";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { ToolCategory } from "@/lib/pi/tool-categories";

interface ToolCategoryRowProps {
  category: ToolCategory;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Room for a control the host adds, e.g. the settings page's expand chevron. */
  trailing?: React.ReactNode;
  /** Accessible name for the switch when one page lists a category twice. */
  switchLabel?: string;
  className?: string;
}

/** One tool category: its icon, what it covers, and the switch that enables it. */
export function ToolCategoryRow({
  category,
  checked,
  onCheckedChange,
  trailing,
  switchLabel,
  className,
}: ToolCategoryRowProps) {
  const Icon = category.icon;

  return (
    <div className={cn("flex items-center justify-between gap-3 py-3", className)}>
      <div className="flex min-w-0 items-center gap-3">
        <Icon className="text-muted-foreground h-4 w-4 shrink-0" />
        <div className="min-w-0 space-y-0.5">
          <Label className="text-sm font-medium">{category.label}</Label>
          <p className="text-muted-foreground text-xs">{category.description}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {trailing}
        <Switch
          checked={checked}
          onCheckedChange={onCheckedChange}
          aria-label={switchLabel ?? category.label}
        />
      </div>
    </div>
  );
}
