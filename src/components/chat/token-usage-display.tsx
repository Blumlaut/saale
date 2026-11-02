"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatTokens } from "@/lib/format";
import type { TurnStats } from "@/lib/pi/turn-stats";
import { cn } from "@/lib/utils";
import { TurnStatsCard } from "./turn-stats-card";
import type { TokenUsage } from "./types";

/** Hover closes after this, so the pointer can cross the gap into the card. */
const CLOSE_DELAY_MS = 150;

/**
 * Percent of the context window in use.
 *
 * Uses Pi's context accounting (`contextTokens`), never the summed token
 * totals: `input` excludes prompt-cache reads, so a cached conversation would
 * read as almost empty. Returns null when Pi has no usable number yet. right
 * after a compaction, until the next response.
 */
export function contextPercent(usage: TokenUsage | null): number | null {
  if (!usage || usage.contextTokens === null || usage.contextWindow <= 0) return null;
  return Math.min((usage.contextTokens / usage.contextWindow) * 100, 100);
}

/**
 * Circular token usage indicator. sits inside the input bar.
 * Always visible (empty ring when no data), fills based on context usage.
 * Clickable to trigger manual compaction with confirmation.
 */
interface ContextCircleProps {
  usage: TokenUsage | null;
  /** The session's turns. when any has stats, hovering shows the same card a message's timestamp does. */
  turns?: ReadonlyArray<TurnStats | undefined>;
  isCompacting: boolean;
  onCompact: () => void;
}

export function ContextCircle({ usage, turns = [], isCompacting, onCompact }: ContextCircleProps) {
  const [showConfirm, setShowConfirm] = useState(false);
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

  const size = 32; // 8px = h-8 w-8
  const strokeWidth = 3;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  // Fill from Pi's context accounting. see contextPercent.
  const percent = contextPercent(usage);
  const contextWindow = usage?.contextWindow ?? 0;
  const dashOffset = circumference - ((percent ?? 0) / 100) * circumference;

  // Color based on usage
  let fillColor = "stroke-white/30";
  if (percent !== null) {
    if (percent > 90) fillColor = "stroke-red-400";
    else if (percent > 75) fillColor = "stroke-amber-400";
    else fillColor = "stroke-blue-400/80";
  }

  const handleClick = useCallback(() => {
    if (isCompacting) return;
    cancelClose();
    setOpen(false);
    setShowConfirm(true);
  }, [isCompacting, cancelClose]);

  const hasStats = turns.some((turn) => turn !== undefined);

  // Before the first turn has stats there is no card to show, so the native
  // tooltip stands in for it.
  const tooltipLines: string[] = [];
  if (usage) {
    tooltipLines.push(
      percent !== null
        ? `Context ${formatTokens(usage.contextTokens ?? 0)}/${formatTokens(contextWindow)} (${Math.round(percent)}%)`
        : "Context usage unavailable",
    );
    tooltipLines.push(`In ${formatTokens(usage.input)} · Out ${formatTokens(usage.output)}`);
  } else {
    tooltipLines.push("No usage data yet");
  }
  if (!isCompacting) {
    tooltipLines.push("Click to compact");
  }
  const tooltip = tooltipLines.join("\n");

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next, details) => {
          // The press is the compact action, not a toggle for this card.
          if (details.reason === "trigger-press") return;
          setOpen(next);
        }}
      >
        <PopoverTrigger
          onClick={handleClick}
          disabled={isCompacting}
          className={cn(
            "h-8 w-8 shrink-0 rounded-full transition-opacity",
            "hover:opacity-80",
            isCompacting ? "cursor-default" : "cursor-pointer",
          )}
          aria-label={tooltip}
          onMouseEnter={() => {
            cancelClose();
            setOpen(true);
          }}
          onMouseLeave={scheduleClose}
        >
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            {/* Background ring */}
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              className="stroke-white/10"
              strokeWidth={strokeWidth}
            />
            {/* Fill ring */}
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              className={cn(
                fillColor,
                "transition-all duration-300",
                isCompacting && "animate-spin",
              )}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={isCompacting ? circumference : dashOffset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          </svg>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="top"
          className={cn("gap-1", hasStats && "w-72 max-w-[calc(100vw-2rem)]")}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          {hasStats ? (
            <TurnStatsCard turns={turns} />
          ) : (
            <p className="text-muted-foreground text-xs leading-5 whitespace-pre-line">{tooltip}</p>
          )}
        </PopoverContent>
      </Popover>

      {/* Confirmation dialog */}
      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Compact conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              This will summarize the conversation history to reduce context usage. Some detail may
              be lost.
              {usage && percent !== null && (
                <span className="block pt-1 text-xs">
                  {formatTokens(usage.contextTokens ?? 0)} / {formatTokens(contextWindow)} tokens (
                  {Math.round(percent)}%)
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShowConfirm(false);
                onCompact();
              }}
            >
              Compact
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
