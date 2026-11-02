"use client";

import { Search } from "lucide-react";
import { ChevronDown } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/** The bordered control both pickers wear as their trigger. */
const TRIGGER_CLASS =
  "border-input bg-background hover:bg-accent/40 focus-visible:border-ring focus-visible:ring-ring/50 flex h-8 max-w-full items-center gap-1.5 rounded-lg border px-2 text-left text-sm transition-colors outline-none focus-visible:ring-3";

/** A value with what to show for it, and the line under it. */
export interface PickerOption {
  value: string;
  label: string;
  hint?: string;
}

/** The options matching a search, over both the label and the value. */
export function filterOptions<T extends PickerOption>(
  options: readonly T[],
  search: string,
): readonly T[] {
  const needle = search.trim().toLowerCase();
  if (needle === "") return options;
  return options.filter(
    (option) =>
      option.label.toLowerCase().includes(needle) || option.value.toLowerCase().includes(needle),
  );
}

/**
 * The popover a picker opens: a search box, the option rows, and a footer.
 *
 * The rows and the footer belong to the picker, so one dropdown and several
 * dropdown read the same way.
 */
export function PickerShell({
  id,
  open,
  onOpenChange,
  label,
  triggerClassName,
  trigger,
  search,
  onSearchChange,
  searchPlaceholder,
  children,
  footer,
}: {
  id?: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible name of the trigger. */
  label: string;
  triggerClassName?: string | undefined;
  trigger: React.ReactNode;
  search: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  children: React.ReactNode;
  footer?: React.ReactNode | undefined;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger id={id} aria-label={label} className={cn(TRIGGER_CLASS, triggerClassName)}>
        <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">{trigger}</span>
        <ChevronDown className="text-muted-foreground h-4 w-4 shrink-0" />
      </PopoverTrigger>

      <PopoverContent
        align="end"
        sideOffset={4}
        className="w-[min(22rem,calc(100vw-2rem))] gap-0 p-0"
      >
        <div className="border-border relative border-b p-2">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-4 h-3.5 w-3.5 -translate-y-1/2" />
          <Input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            autoFocus
            className="h-8 pl-8 text-sm"
          />
        </div>

        <div className="max-h-64 overflow-y-auto p-1" role="listbox">
          {children}
        </div>

        {footer ? <div className="border-border border-t p-2">{footer}</div> : null}
      </PopoverContent>
    </Popover>
  );
}

/** The line a picker shows when nothing matches its search. */
export function PickerEmpty({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground px-2 py-6 text-center text-xs">{children}</p>;
}
