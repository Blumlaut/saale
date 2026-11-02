"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { formatCost, formatTokens } from "@/lib/format";
import {
  mergeTurnStats,
  TURN_STATS_PARTS,
  type TurnStats,
  type TurnStatsPart,
} from "@/lib/pi/turn-stats";
import { cn } from "@/lib/utils";

/** The label and colour of each slice of the context. */
const PART_TEXT: Record<TurnStatsPart, { label: string; swatch: string }> = {
  systemPrompt: { label: "System prompt", swatch: "bg-primary" },
  // A tint of the accent: `secondary` is the popover's own surface tone and disappears on it.
  tools: { label: "Tools", swatch: "bg-primary/40" },
  userMessages: { label: "Your messages", swatch: "bg-chart-4" },
  responses: { label: "Responses", swatch: "bg-chart-2" },
};

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
  const [focused, setFocused] = useState<TurnStatsPart | null>(null);
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

  const { context, model, tokens } = stats;
  const modelName = model.name || model.responseModel || "unknown";
  const parts = TURN_STATS_PARTS.map((key) => ({
    key,
    tokens: context.parts[key],
    ...PART_TEXT[key],
  }));
  const partTotal = parts.reduce((sum, part) => sum + part.tokens, 0);
  const percentOf = (value: number) => (partTotal > 0 ? Math.round((value / partTotal) * 100) : 0);
  const contextPercent =
    context.tokens !== null && context.window > 0
      ? Math.min(Math.round((context.tokens / context.window) * 100), 100)
      : null;
  const turnCount = turns.filter((turn) => turn !== undefined).length;

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
        <div className="flex items-baseline justify-between gap-2">
          <span className="console-label">Model</span>
          <span className="min-w-0 truncate text-xs font-medium" title={modelName}>
            {modelName}
          </span>
        </div>

        <div className="text-muted-foreground flex flex-wrap items-baseline gap-x-1 text-[11px]">
          <span>
            <span className="text-foreground font-medium tabular-nums">
              {formatTokens(tokens.input)}
            </span>{" "}
            in
          </span>
          <span aria-hidden>·</span>
          <span>
            <span className="text-foreground font-medium tabular-nums">
              {formatTokens(tokens.output)}
            </span>{" "}
            out
          </span>
          {tokens.cacheRead > 0 && (
            <>
              <span aria-hidden>·</span>
              <span>
                <span className="text-foreground font-medium tabular-nums">
                  {formatTokens(tokens.cacheRead)}
                </span>{" "}
                cached
              </span>
            </>
          )}
          <span className="text-foreground ml-auto text-xs font-medium tabular-nums">
            {formatCost(stats.cost)}
          </span>
        </div>

        <Separator className="my-1" />

        <div className="flex items-baseline justify-between gap-2">
          <span className="console-label">Context</span>
          <span className="text-muted-foreground text-[11px] tabular-nums">
            {context.tokens === null
              ? "unknown"
              : context.window > 0
                ? `${formatTokens(context.tokens)} / ${formatTokens(context.window)}`
                : `${formatTokens(context.tokens)} used`}
            {contextPercent !== null && ` · ${contextPercent}%`}
          </span>
        </div>

        <div className="mt-1 flex h-2 gap-px overflow-hidden rounded-[3px]">
          {parts.map((part) => (
            <span
              key={part.key}
              style={{ width: `${partTotal > 0 ? (part.tokens / partTotal) * 100 : 0}%` }}
              className={cn(
                "h-full transition",
                part.swatch,
                // Grey as well as faint: a dimmed accent tint reads like the full one beside it.
                focused !== null && focused !== part.key && "opacity-30 grayscale",
              )}
              onMouseEnter={() => setFocused(part.key)}
              onMouseLeave={() => setFocused(null)}
            />
          ))}
        </div>

        <ul className="mt-1.5">
          {parts.map((part) => (
            <li key={part.key}>
              <button
                type="button"
                onMouseEnter={() => setFocused(part.key)}
                onMouseLeave={() => setFocused(null)}
                onFocus={() => setFocused(part.key)}
                onBlur={() => setFocused(null)}
                onClick={() => setFocused(part.key)}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded-sm px-1 py-px text-left text-[11px] transition-colors",
                  focused === part.key ? "bg-accent text-foreground" : "text-muted-foreground",
                )}
              >
                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-[1px]", part.swatch)} />
                <span className="truncate">{part.label}</span>
                <span className="text-foreground ml-auto shrink-0 font-medium tabular-nums">
                  {formatTokens(part.tokens)}
                </span>
                <span className="w-7 shrink-0 text-right tabular-nums">
                  {part.tokens > 0 && percentOf(part.tokens) === 0
                    ? "<1%"
                    : `${percentOf(part.tokens)}%`}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <div className="text-muted-foreground mt-1 flex items-center gap-1.5 border-t pt-1.5 text-[10.5px]">
          <span className="border-border text-foreground rounded-[3px] border px-1 py-px">
            {stats.costFromProvider ? "billed" : "estimated"}
          </span>
          <span className="truncate">{model.provider}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0">
            {turnCount} {turnCount === 1 ? "turn" : "turns"}
          </span>
        </div>
      </PopoverContent>
    </Popover>
  );
}
