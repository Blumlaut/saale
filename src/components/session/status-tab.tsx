"use client";

import type { ReactNode } from "react";
import { Separator } from "@/components/ui/separator";
import { TurnStatsCard } from "@/components/chat/turn-stats-card";
import type { TurnStats } from "@/lib/pi/turn-stats";

/**
 * The session at a glance: what its context holds, and what fires into it.
 *
 * The context block is the same card the composer's ring and a response's
 * timestamp show, so the numbers here are the ones the transcript reports.
 * The automations are the same rows the header's radar opens, listed where a
 * reader goes to ask what a chat is doing on its own.
 */
export function SessionStatusTab({
  turns,
  automations,
  automationsAction,
}: {
  /** The turns' stats, in order; the newest is the one the context block reads. */
  turns: ReadonlyArray<TurnStats | undefined>;
  /** The panel's automation rows. */
  automations: ReactNode;
  /** Where the section sends a reader who wants to change a binding. */
  automationsAction?: ReactNode;
}) {
  const reported = turns.some((turn) => turn !== undefined);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <section className="px-3 py-3">
        <h3 className="console-label mb-2">Context</h3>
        {reported ? (
          <TurnStatsCard turns={turns} />
        ) : (
          <p className="text-muted-foreground text-xs">
            No turn has reported what it cost yet. Send a message to fill this in.
          </p>
        )}
      </section>

      <Separator />

      <section className="pb-2">
        <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-1">
          <h3 className="console-label">Automations</h3>
          {automationsAction}
        </div>
        <div className="px-1">{automations}</div>
      </section>
    </div>
  );
}
