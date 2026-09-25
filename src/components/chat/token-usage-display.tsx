"use client";

import { useState, useCallback } from "react";
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
import { cn } from "@/lib/utils";
import type { TokenUsage } from "./types";

/**
 * Format token count as human-readable string.
 * e.g. 1234 → "1.2K", 1234567 → "1.2M"
 */
function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return count.toString();
}

/**
 * Percent of the context window in use.
 *
 * Uses Pi's context accounting (`contextTokens`), never the summed token
 * totals: `input` excludes prompt-cache reads, so a cached conversation would
 * read as almost empty. Returns null when Pi has no usable number yet — right
 * after a compaction, until the next response.
 */
export function contextPercent(usage: TokenUsage | null): number | null {
  if (!usage || usage.contextTokens === null || usage.contextWindow <= 0) return null;
  return Math.min((usage.contextTokens / usage.contextWindow) * 100, 100);
}

/**
 * Circular token usage indicator — sits inside the input bar.
 * Always visible (empty ring when no data), fills based on context usage.
 * Clickable to trigger manual compaction with confirmation.
 */
interface ContextCircleProps {
  usage: TokenUsage | null;
  isCompacting: boolean;
  onCompact: () => void;
}

export function ContextCircle({ usage, isCompacting, onCompact }: ContextCircleProps) {
  const [showConfirm, setShowConfirm] = useState(false);

  const size = 32; // 8px = h-8 w-8
  const strokeWidth = 3;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  // Fill from Pi's context accounting — see contextPercent.
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
    if (!isCompacting) {
      setShowConfirm(true);
    }
  }, [isCompacting]);

  // Tooltip content
  const tooltipParts: string[] = [];
  if (usage) {
    tooltipParts.push(`${formatTokens(usage.input)} in / ${formatTokens(usage.output)} out`);
    tooltipParts.push(
      percent !== null
        ? `${formatTokens(usage.contextTokens ?? 0)} / ${formatTokens(contextWindow)} (${Math.round(percent)}%)`
        : "Context usage unavailable",
    );
  } else {
    tooltipParts.push("No usage data yet");
  }
  if (!isCompacting) {
    tooltipParts.push("Click to compact");
  }
  const tooltip = tooltipParts.join(" · ");

  return (
    <>
      {/* Circular indicator */}
      <button
        type="button"
        onClick={handleClick}
        disabled={isCompacting}
        title={tooltip}
        className={cn(
          "h-8 w-8 shrink-0 rounded-full transition-opacity",
          "hover:opacity-80",
          isCompacting ? "cursor-default" : "cursor-pointer",
        )}
        aria-label={tooltip}
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
            className={cn(fillColor, "transition-all duration-300", isCompacting && "animate-spin")}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={isCompacting ? circumference : dashOffset}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        </svg>
      </button>

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
