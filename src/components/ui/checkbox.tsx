"use client";

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer group/checkbox text-primary focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 data-state-checked:bg-primary data-state-checked:text-primary-foreground data-state-checked:border-primary data-state-indeterminate:bg-primary data-state-indeterminate:text-primary-foreground data-state-indeterminate:border-primary dark:data-state-checked:bg-primary dark:data-state-checked:text-primary-foreground dark:data-state-indeterminate:bg-primary dark:data-state-indeterminate:text-primary-foreground dark:data-state-indeterminate:border-primary border-input inline-flex size-4 shrink-0 items-center justify-center rounded-sm border transition-[color,box-shadow] outline-none focus-visible:ring-3 aria-invalid:ring-3 data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="group-data-[transition-status=deactivating]/checkbox:animate-out group-data-[transition-status=activating]/checkbox:animate-in group-data-[transition-status=deactivating]/checkbox:fade-in-0 group-data-[transition-status=activating]/checkbox:fade-in-80 group-data-[transition-status=deactivating]/checkbox:zoom-in-100 group-data-[transition-status=activating]/checkbox:zoom-in-75 flex items-center justify-center text-current transition-transform"
      >
        <Check className="size-3.5" strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
