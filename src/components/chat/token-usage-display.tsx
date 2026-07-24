"use client";

import { useEffect } from "react";

interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  contextWindow: number;
}

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
 * Token usage display — shows input/output tokens and context usage bar.
 * Mounted inside the InputBar so it's always visible at the bottom.
 */
export function TokenUsageDisplay({ usage }: { usage: TokenUsage | null }) {
  if (!usage || !usage.contextWindow) return null;

  const usagePercent = Math.min((usage.total / usage.contextWindow) * 100, 100);
  const isWarning = usagePercent > 75;
  const isCritical = usagePercent > 90;

  // Determine bar color based on usage
  let barColor = "bg-blue-500/60";
  if (isCritical) barColor = "bg-red-500/80";
  else if (isWarning) barColor = "bg-amber-500/70";

  return (
    <div className="text-muted-foreground/70 flex items-center gap-2 text-xs">
      <span className="shrink-0">
        {formatTokens(usage.input)} in / {formatTokens(usage.output)} out
      </span>
      <div className="min-h-0 flex-1">
        <div className="h-1 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className={`h-full rounded-full transition-all duration-300 ${barColor}`}
            style={{ width: `${usagePercent}%` }}
          />
        </div>
      </div>
      <span className="shrink-0 tabular-nums">{Math.round(usagePercent)}%</span>
    </div>
  );
}

/**
 * Compaction progress overlay — shown while compaction is in progress.
 */
export function CompactionProgress({ isActive }: { isActive: boolean }) {
  if (!isActive) return null;

  return (
    <div className="text-muted-foreground/80 flex items-center gap-2 text-xs">
      <div className="h-3 w-3 animate-spin rounded-full border-2 border-blue-500/60 border-t-transparent" />
      <span>Summarizing conversation…</span>
    </div>
  );
}

/**
 * Hook that listens for token_usage and compaction SSE events.
 */
export function useTokenUsage(
  eventSource: EventSource | null,
  onUsage: (usage: TokenUsage) => void,
  onCompactionStart: () => void,
  onCompactionEnd: () => void,
) {
  useEffect(() => {
    if (!eventSource) return;

    eventSource.addEventListener("token_usage", (event: MessageEvent) => {
      const parsed = JSON.parse(event.data) as TokenUsage;
      onUsage(parsed);
    });

    eventSource.addEventListener("compaction_start", () => {
      onCompactionStart();
    });

    eventSource.addEventListener("compaction_end", () => {
      onCompactionEnd();
    });

    return () => {
      eventSource.removeEventListener("token_usage", () => {});
      eventSource.removeEventListener("compaction_start", () => {});
      eventSource.removeEventListener("compaction_end", () => {});
    };
  }, [eventSource, onUsage, onCompactionStart, onCompactionEnd]);
}
