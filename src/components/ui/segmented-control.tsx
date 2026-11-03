"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Native tooltip for the option, when its label needs the room. */
  title?: string;
}

interface SegmentedControlProps<T extends string> {
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  /** Names the choice for a screen reader. */
  label: string;
  disabled?: boolean;
  /** Let the options wrap onto a second line instead of overflowing. */
  wrap?: boolean;
  /** `xs` sits in a toolbar; `sm` matches a page action's height. */
  size?: "xs" | "sm";
  className?: string;
}

/**
 * A row of buttons where one option is on. Every choice is on the surface, so
 * picking one costs a single click.
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
  wrap,
  size = "xs",
  className,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("flex gap-1.5", wrap ? "flex-wrap" : "flex-nowrap", className)}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Button
            key={option.value}
            type="button"
            size={size === "sm" ? "icon" : "xs"}
            className={size === "sm" ? "h-8 w-auto px-2.5 text-xs" : undefined}
            variant={selected ? "default" : "secondary"}
            aria-pressed={selected}
            {...(option.title === undefined ? {} : { title: option.title })}
            disabled={disabled}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </Button>
        );
      })}
    </div>
  );
}
