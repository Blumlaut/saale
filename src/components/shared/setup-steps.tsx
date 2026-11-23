"use client";

import { Check } from "lucide-react";

/**
 * The steps of a guided setup, as a dialog or a card shows them.
 *
 * The caller decides which step is current; a dialog that follows a sign-in
 * moves on by itself as the outside world catches up.
 */
export function SetupSteps({
  steps,
  current,
  onSelect,
  className,
}: {
  steps: readonly string[];
  /** 1-based step the user is on. */
  current: number;
  /** Lets a step be jumped to, for a wizard whose steps are all reachable. */
  onSelect?: (step: number) => void;
  className?: string;
}) {
  return (
    <div className={className ? `flex items-center gap-2 ${className}` : "flex items-center gap-2"}>
      {steps.map((label, index) => {
        const number = index + 1;
        const content = (
          <>
            <StepDot index={number} current={current} />
            <span
              className={[
                "truncate text-[11px]",
                number === current ? "text-foreground" : "text-muted-foreground",
              ].join(" ")}
            >
              {label}
            </span>
          </>
        );
        return (
          <div key={label} className="flex min-w-0 items-center gap-1.5">
            {onSelect && number !== current ? (
              <button
                type="button"
                className="flex min-w-0 items-center gap-1.5"
                aria-label={`Go to ${label}`}
                onClick={() => onSelect(number)}
              >
                {content}
              </button>
            ) : (
              content
            )}
            {number < steps.length && <span className="text-border px-0.5">·</span>}
          </div>
        );
      })}
    </div>
  );
}

/** One number in the stepper: done, current, or still to come. */
function StepDot({ index, current }: { index: number; current: number }) {
  const done = index < current;
  const active = index === current;
  return (
    <span
      className={[
        "flex h-5 w-5 items-center justify-center rounded-full border font-mono text-[10px]",
        done
          ? "border-primary/40 bg-primary/10 text-primary"
          : active
            ? "border-primary text-primary"
            : "border-border/60 text-muted-foreground",
      ].join(" ")}
      aria-current={active ? "step" : undefined}
    >
      {done ? <Check className="h-3 w-3" /> : index}
    </span>
  );
}
