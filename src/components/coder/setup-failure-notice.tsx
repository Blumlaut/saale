"use client";

import { useState } from "react";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatRelativeDate } from "@/lib/format";
import type { CoderSetupFailure } from "./use-coder-data";

/** Enough of a failed install's output to read on a panel this narrow. */
const OUTPUT_MAX_HEIGHT = "max-h-40";

/**
 * The warning that this chat's setup script failed, in the chat's sidebar.
 *
 * A failing script does not stop the chat. the agent starts in the checkout
 * anyway. So without this the only trace is a worktree with no dependencies and
 * an agent guessing why nothing runs. Folded by default, because the exit status
 * is the whole message for a user who already knows; unfolded, it is what the
 * script printed, which is where the actual error is.
 */
export function SetupFailureNotice({ failure }: { failure: CoderSetupFailure | null }) {
  const [open, setOpen] = useState(false);

  if (!failure) return null;

  const output = failure.output.trim();
  const when = formatRelativeDate(failure.failedAt);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="border-destructive/30 bg-destructive/5 border-b px-2 py-2"
    >
      <CollapsibleTrigger
        aria-label={open ? "Hide the setup script's error" : "Show the setup script's error"}
        className="group hover:bg-destructive/10 flex w-full items-start gap-2 rounded-lg px-1 py-1 text-left transition-colors duration-150"
      >
        <AlertTriangle className="text-destructive mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="text-destructive block text-xs font-medium">Setup script failed</span>
          <span className="text-muted-foreground block text-xs break-words">
            Its dependencies may be missing in this worktree.
          </span>
        </span>
        <ChevronRight className="text-muted-foreground mt-0.5 h-3.5 w-3.5 shrink-0 transition-transform duration-150 group-data-panel-open:rotate-90" />
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="mt-1.5 min-w-0 px-1">
          <p className="console-label flex items-center gap-1.5">
            <span>{failure.exitCode === null ? "Did not run" : `Exit ${failure.exitCode}`}</span>
            {when && <span aria-hidden>·</span>}
            {when && <span>{when}</span>}
          </p>
          {/* Wrapped, never scrolled sideways: the panel is 240px wide on a
              phone and the error is the one thing that must stay readable. */}
          <pre
            className={`border-border/40 bg-muted/40 text-foreground/80 mt-1 overflow-y-auto rounded-lg border p-2 font-mono text-[11px] break-words whitespace-pre-wrap ${OUTPUT_MAX_HEIGHT}`}
          >
            {output || "The script printed nothing."}
          </pre>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
