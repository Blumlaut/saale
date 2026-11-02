"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { mergeTurnStats, type TurnStats } from "@/lib/pi/turn-stats";
import { cn } from "@/lib/utils";
import { TurnStatsCard } from "./turn-stats-card";

/** Hover closes after this, so the pointer can cross the gap into the card. */
const CLOSE_DELAY_MS = 150;

interface MessageStatsProps {
  /** The group's turns, in order. Empty or all-missing renders the plain time. */
  turns: ReadonlyArray<TurnStats | undefined>;
  createdAt: string;
}

/**
 * The time a response finished, and, on hover or tap, what it cost and what
 * filled the context while it ran.
 *
 * Hover opens for a mouse and a tap opens the same card on a phone. A press on
 * the time never closes it: the pointer is already inside, so a click that
 * toggled it shut would fight the hover that opened it.
 */
export function MessageStats({ turns, createdAt }: MessageStatsProps) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  }, [cancelClose]);

  useEffect(() => cancelClose, [cancelClose]);

  const stats = mergeTurnStats(turns);
  const time = new Date(createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  if (!stats) {
    return <span className="text-muted-foreground">{time}</span>;
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        if (!next && details.reason === "trigger-press") return;
        setOpen(next);
      }}
    >
      <PopoverTrigger
        onMouseEnter={() => {
          cancelClose();
          setOpen(true);
        }}
        onMouseLeave={scheduleClose}
        className={cn(
          "text-muted-foreground hover:text-foreground rounded-sm underline decoration-dotted decoration-1 underline-offset-2 transition-colors",
          open && "text-foreground",
        )}
        aria-label="Token usage and cost for this response"
      >
        {time}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        className="w-72 max-w-[calc(100vw-2rem)] gap-1"
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
      >
        <TurnStatsCard turns={turns} />
      </PopoverContent>
    </Popover>
  );
}
