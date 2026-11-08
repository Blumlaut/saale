import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

/** The one busy indicator: anything still running wears this. */
export function Spinner({
  className,
  label = "Loading",
}: {
  className?: string;
  /** What is running, for screen readers. */
  label?: string;
}) {
  return (
    <Loader2 aria-label={label} className={cn("h-3.5 w-3.5 shrink-0 animate-spin", className)} />
  );
}
