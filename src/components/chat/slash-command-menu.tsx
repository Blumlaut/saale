"use client";

import { cn } from "@/lib/utils";
import type { CommandMeta } from "@/lib/commands/types";

/**
 * The composer's `/` picker.
 *
 * Presentational: the input bar owns the textarea, the highlight index and the
 * keys, and calls `onSelect` with the chosen command name.
 */
export function SlashCommandMenu({
  commands,
  activeIndex,
  onSelect,
  onHighlight,
}: {
  commands: readonly CommandMeta[];
  activeIndex: number;
  onSelect: (name: string) => void;
  onHighlight: (index: number) => void;
}) {
  if (commands.length === 0) return null;

  return (
    <div
      role="listbox"
      aria-label="Slash commands"
      className="liquid-glass absolute inset-x-3 bottom-full z-20 mb-2 overflow-hidden rounded-xl p-1 shadow-lg"
    >
      {commands.map((meta, index) => {
        const Icon = meta.icon;
        const active = index === activeIndex;
        return (
          <button
            key={meta.name}
            type="button"
            role="option"
            aria-selected={active}
            // Keep the caret in the textarea — the picker must not steal focus.
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => onHighlight(index)}
            onClick={() => onSelect(meta.name)}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
              active ? "bg-accent/60" : "hover:bg-accent/60",
            )}
          >
            <Icon className="text-muted-foreground h-4 w-4 shrink-0" />
            <span className="shrink-0 font-mono text-sm font-medium">/{meta.name}</span>
            <span className="text-muted-foreground min-w-0 truncate text-xs">
              {meta.description}
            </span>
          </button>
        );
      })}
    </div>
  );
}
