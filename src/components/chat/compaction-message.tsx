"use client";

import { useState, useCallback } from "react";
import { cn } from "@/lib/utils";
import { MarkdownRenderer } from "./markdown-renderer";
import { ChevronDown, ChevronRight, Sparkles, Loader2 } from "lucide-react";
import type { Message } from "./types";

/**
 * Format token count as human-readable string.
 */
function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return count.toString();
}

/**
 * Compaction message — shows a collapsible summary of what was condensed.
 * Renders as a centered divider with the summary expandable on click.
 */
export function CompactionMessage({
  message,
  isCompacting,
}: {
  message: Message;
  isCompacting?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  const toggle = useCallback(() => {
    if (!isCompacting) {
      setExpanded((prev) => !prev);
    }
  }, [isCompacting]);

  const tokensBefore = message.compaction?.tokensBefore ?? 0;

  return (
    <div className="space-y-3">
      {/* Divider with badge */}
      <div className="flex items-center gap-3">
        {/* Left spacer */}
        <div className="h-px flex-[1_1_0] bg-white/10" />

        {/* Center badge */}
        <button
          onClick={toggle}
          className="shrink-0"
          aria-expanded={expanded}
          aria-label="Toggle compaction summary"
        >
          <div
            className={cn(
              "flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs transition-colors hover:bg-white/10",
              isCompacting && "cursor-wait",
            )}
          >
            {isCompacting ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                <span className="text-muted-foreground">Summarizing conversation…</span>
              </>
            ) : (
              <>
                {expanded ? (
                  <ChevronDown className="text-muted-foreground h-3 w-3" />
                ) : (
                  <ChevronRight className="text-muted-foreground h-3 w-3" />
                )}
                <Sparkles className="h-3 w-3" />
                <span className="text-muted-foreground">
                  {tokensBefore > 0 ? `${formatTokens(tokensBefore)} tokens` : "Compacted"}
                </span>
              </>
            )}
          </div>
        </button>

        {/* Right spacer */}
        <div className="h-px flex-[1_1_0] bg-white/10" />
      </div>

      {/* Expandable summary */}
      {expanded && !isCompacting && (
        <div className="mx-auto max-w-2xl">
          <div className="liquid-glass-inner rounded-xl p-4">
            <MarkdownRenderer content={message.content} />
          </div>
        </div>
      )}
    </div>
  );
}
