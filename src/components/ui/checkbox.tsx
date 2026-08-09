"use client";

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer group/checkbox text-primary focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 data-checked:bg-primary data-checked:text-primary-foreground data-checked:border-primary data-indeterminate:bg-primary data-indeterminate:text-primary-foreground data-indeterminate:border-primary dark:data-checked:bg-primary dark:data-checked:text-primary-foreground dark:data-indeterminate:bg-primary dark:data-indeterminate:text-primary-foreground dark:data-indeterminate:border-primary border-input inline-flex size-4 shrink-0 items-center justify-center rounded-sm border transition-[color,box-shadow] outline-none focus-visible:ring-3 aria-invalid:ring-3 data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="group-data-[ending-style]/checkbox:animate-out group-data-[starting-style]/checkbox:animate-in group-data-[ending-style]/checkbox:fade-in-0 group-data-[starting-style]/checkbox:fade-in-80 group-data-[ending-style]/checkbox:zoom-in-100 group-data-[starting-style]/checkbox:zoom-in-75 flex items-center justify-center text-current transition-transform"
      >
        <Check className="size-3.5" strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
