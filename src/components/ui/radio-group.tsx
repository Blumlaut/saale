"use client";

import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";

import { cn } from "@/lib/utils";

/**
 * A group of radios where exactly one option is chosen.
 *
 * Base UI renders a `<span>` plus a hidden `<input>`, so a `<Label>` around a
 * row selects it when the text is clicked — the whole row is the target, not a
 * four-pixel dot.
 */
function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={cn("grid gap-2", className)}
      {...props}
    />
  );
}

function Radio({ className, ...props }: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      data-slot="radio"
      className={cn(
        "peer group/radio text-primary focus-visible:border-ring focus-visible:ring-ring/50 data-checked:border-primary data-checked:text-primary border-input inline-flex size-4 shrink-0 items-center justify-center rounded-full border transition-[color,box-shadow] outline-none focus-visible:ring-3 data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <RadioPrimitive.Indicator
        data-slot="radio-indicator"
        className="group-data-[ending-style]/radio:animate-out group-data-[starting-style]/radio:animate-in group-data-[ending-style]/radio:fade-in-0 group-data-[starting-style]/radio:fade-in-80 group-data-[ending-style]/radio:zoom-in-100 group-data-[starting-style]/radio:zoom-in-75 flex items-center justify-center"
      >
        <span className="bg-primary size-2 rounded-full" />
      </RadioPrimitive.Indicator>
    </RadioPrimitive.Root>
  );
}

export { Radio, RadioGroup };
