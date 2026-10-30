"use client";

import { AlertCircle, CheckCircle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * What a settings page has to say about saving. `dirty` is for the one page
 * that keeps a draft and a Save button.
 */
export type SaveState = "idle" | "saving" | "saved" | "error" | "dirty";

/** How long a "Saved" or failure line stays up before it goes back to rest. */
export const SAVE_STATE_CLEAR_MS = 3000;

const LABELS: Record<SaveState, string> = {
  idle: "Changes save automatically",
  dirty: "Unsaved changes",
  saving: "Saving…",
  saved: "Saved",
  error: "Could not save that change",
};

const ICONS = {
  saving: Loader2,
  saved: CheckCircle,
  error: AlertCircle,
} as const;

export function AutosaveStatus({ state, className }: { state: SaveState; className?: string }) {
  const Icon = state === "idle" || state === "dirty" ? null : ICONS[state];

  return (
    <span
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-center gap-1.5 text-xs",
        state === "error" ? "text-destructive" : "text-muted-foreground",
        className,
      )}
    >
      {Icon ? <Icon className={cn("h-3.5 w-3.5", state === "saving" && "animate-spin")} /> : null}
      {LABELS[state]}
    </span>
  );
}

/**
 * A settings page that saves as you change it: the content scrolls, and the
 * status line stays in view underneath.
 */
export function AutosavedPage({
  state,
  children,
}: {
  state: SaveState;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto">{children}</div>
      <div className="flex h-5 shrink-0 items-center px-1">
        <AutosaveStatus state={state} />
      </div>
    </div>
  );
}
