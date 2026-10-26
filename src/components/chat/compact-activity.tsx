"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Lightbulb, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { plural, truncate } from "@/lib/format";
import { FaviconMark } from "./favicon-mark";
import type { ToolCallRenderer } from "./collapsed-tool-calls";
import type { ToolMark } from "./tool-mark-model";
import type { ToolCallData } from "./types";

/**
 * One turn's reasoning and tool calls, condensed to a line each.
 *
 * The step-by-step transcript stacks a card and a thinking block per step, so a
 * long turn grows without bound. Here a run of steps is summarised instead: the
 * newest reasoning shown inline (replaced as the next step starts) and one
 * running tool count. Both lines expand into the same detail the step-by-step
 * view shows, so nothing is lost. it is deferred.
 *
 * The count and the icons update in place rather than appending, which is what
 * keeps the transcript from growing while the turn is still running.
 *
 * Both lines report progress from the *turn*, not from the tokens arriving: the
 * turn is active from the moment it starts until its final reply begins, tools
 * included. A per-token flag would drop every time a step paused to run a tool,
 * which is a blink.
 *
 * The leaf renderer and the mark are injected, so the share page gets the same
 * row with redacted leaves and category marks without any owner card. or the
 * routing table. becoming reachable from it.
 */

/** Characters of the newest reasoning shown before it is cut off. */
const SNIPPET_CHARS = 80;
/** Marks on screen at once. a sliding window over a run of any length. */
const VISIBLE_MARKS = 6;
/**
 * One slot: a mark (`h-3.5`) plus a 4px gap. In rem, so the pitch follows the
 * root font size the same way the marks themselves do.
 */
const SLOT_REM = 1.125;

export interface CompactActivityProps {
  /** The run's reasoning, oldest step first. one entry per step that reasoned. */
  reasoning: readonly string[];
  /** The work those steps did, in call order. */
  toolCalls: readonly ToolCallData[];
  /**
   * The turn this run belongs to is still being worked on. true across its tool
   * runs, false once its final reply starts (that reply is its own block).
   */
  isActive: boolean;
  /** How one call in the run renders. the owner's card, or the redacted one. */
  renderCall: ToolCallRenderer;
  /** How a call is marked in the sliding window. */
  markOf: (toolCall: ToolCallData) => ToolMark;
}

export function CompactActivity({
  reasoning,
  toolCalls,
  isActive,
  renderCall,
  markOf,
}: CompactActivityProps) {
  return (
    <div className="space-y-1">
      {reasoning.length > 0 && <ReasoningRow reasoning={reasoning} isActive={isActive} />}
      {toolCalls.length > 0 && (
        <ToolsRow
          toolCalls={toolCalls}
          isActive={isActive}
          renderCall={renderCall}
          markOf={markOf}
        />
      )}
    </div>
  );
}

/**
 * "Thinking". the newest reasoning, full text one click down.
 *
 * The label never changes with the turn's state. a row that flips to "Thought
 * process" once it settles reads as a different row, and a transcript full of
 * them makes the finished turns look nothing like the running one. The spinner
 * is what reports progress, and it alone comes and goes.
 */
function ReasoningRow({
  reasoning,
  isActive,
}: {
  reasoning: readonly string[];
  isActive: boolean;
}) {
  const [open, setOpen] = useState(false);
  // The step the row is currently showing is the newest one. so a replacement
  // is exactly a change in how many steps reasoned, never a token arriving.
  // Keying the line on that count replays the entrance when it is replaced and
  // leaves the streaming text alone, which is what makes it cheap.
  const stepCount = reasoning.length;
  const snippet = truncate(reasoning[stepCount - 1]!.replace(/\s+/g, " ").trim(), SNIPPET_CHARS);

  return (
    <div className="liquid-glass-inner rounded-xl">
      <Button
        variant="ghost"
        size="xs"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className="h-auto w-full min-w-0 justify-start gap-2 rounded-lg px-3 py-2 text-left text-xs font-normal"
      >
        {open ? (
          <ChevronDown className="text-muted-foreground size-3 shrink-0" />
        ) : (
          <ChevronRight className="text-muted-foreground size-3 shrink-0" />
        )}
        <Lightbulb className="text-muted-foreground size-3 shrink-0" />
        <span className="shrink-0 text-xs font-medium">Thinking</span>
        <span
          key={stepCount}
          className="text-muted-foreground animate-in fade-in min-w-0 flex-1 truncate text-xs duration-150 ease-out"
        >
          {snippet}
        </span>
        {isActive && <Loader2 className="text-muted-foreground size-3 shrink-0 animate-spin" />}
      </Button>

      {open && (
        <div className="border-border/30 border-t px-3 py-2">
          <pre className="text-muted-foreground bg-muted rounded-lg p-3 text-xs leading-relaxed whitespace-pre-wrap">
            {reasoning.join("\n\n")}
          </pre>
        </div>
      )}
    </div>
  );
}

/** "Used 7 tools". a running count, a sliding window of marks, a spinner while the turn works. */
function ToolsRow({
  toolCalls,
  isActive,
  renderCall: RenderCall,
  markOf,
}: {
  toolCalls: readonly ToolCallData[];
  isActive: boolean;
  renderCall: ToolCallRenderer;
  markOf: (toolCall: ToolCallData) => ToolMark;
}) {
  const [open, setOpen] = useState(false);
  // Only the newest marks are on screen: a run of forty tools is a count, not
  // forty icons. The window slides, so a mark that ages out is dropped and the
  // newest takes its slot.
  const marks = toolCalls.slice(-VISIBLE_MARKS);

  return (
    <div className="liquid-glass-inner rounded-xl">
      <Button
        variant="ghost"
        size="xs"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className="h-auto w-full min-w-0 justify-start gap-2 rounded-lg px-3 py-2 text-left text-xs font-normal"
      >
        {open ? (
          <ChevronDown className="text-muted-foreground size-3 shrink-0" />
        ) : (
          <ChevronRight className="text-muted-foreground size-3 shrink-0" />
        )}
        {/* The count absorbs the pressure, so a run's marks never widen the row. */}
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          Used {plural(toolCalls.length, "tool", "tools")}
        </span>

        {/* Decorative: the count above is the accessible name. */}
        <span
          aria-hidden
          className="relative h-3.5 shrink-0 overflow-hidden"
          style={{ width: `${marks.length * SLOT_REM}rem` }}
        >
          {marks.map((call, index) => (
            <span
              key={call.id}
              className="absolute top-0 left-0 transition-transform duration-200 ease-out"
              style={{ transform: `translateX(${index * SLOT_REM}rem)` }}
            >
              {/* Nested: the entrance animates a scale, which must not fight
                    the slot transform that slides the window along. */}
              <span className="animate-in fade-in zoom-in-75 block h-3.5 w-3.5 duration-200 ease-out">
                <ToolMarkView mark={markOf(call)} />
              </span>
            </span>
          ))}
        </span>

        {isActive && <Loader2 className="text-muted-foreground size-3 shrink-0 animate-spin" />}
      </Button>

      {open && (
        <div className="border-border/30 space-y-1.5 border-t p-2">
          {toolCalls.map((toolCall) => (
            <RenderCall key={toolCall.id} toolCall={toolCall} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One call's mark: the site it opened, or the tool's icon. */
function ToolMarkView({ mark }: { mark: ToolMark }) {
  if (mark.kind === "favicon") {
    return (
      <FaviconMark url={mark.url} className="h-3.5 w-3.5 shrink-0 rounded-sm object-contain" />
    );
  }

  const Icon = mark.icon;
  return <Icon className="text-muted-foreground h-3.5 w-3.5 shrink-0" />;
}
