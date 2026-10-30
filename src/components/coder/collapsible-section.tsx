"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/**
 * A foldable area of the panel: a header row that collapses its content, with
 * the counts on the right where the eye lands before the fold.
 *
 * `action` sits beside the trigger rather than inside it: the trigger is a
 * button, and a button in a button is invalid HTML.
 */
export function CollapsibleSection({
  label,
  right,
  action,
  children,
  defaultOpen = true,
}: {
  label: ReactNode;
  right?: ReactNode;
  /** A control that belongs to the section, e.g. "Stage all". */
  action?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b">
      <div className="flex items-center">
        <CollapsibleTrigger className="group hover:bg-accent/40 flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 pl-3 text-left transition-colors">
          <ChevronDown
            className={cn(
              "text-muted-foreground h-3 w-3 shrink-0 -rotate-90 transition-transform",
              open && "rotate-0",
            )}
          />
          <span className="console-label min-w-0 flex-1 truncate">{label}</span>
          {right}
        </CollapsibleTrigger>
        {action && <div className="shrink-0 pr-2">{action}</div>}
      </div>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}
