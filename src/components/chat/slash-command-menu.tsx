"use client";

import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** One row of the composer's `/` menu: a command, a prompt, or an argument to fill. */
export interface SlashMenuItem {
  kind: "command" | "prompt" | "argument" | "value";
  name: string;
  description: string;
  icon: LucideIcon;
  /** Prompts: the arguments the template expects, e.g. `<path> [focus]`. */
  hint?: string | null;
  /** Arguments: `required` or `optional`. */
  note?: string | null;
  /** The files row: how many the composer is holding. */
  attached?: number;
}

/**
 * The composer's `/` picker.
 *
 * Presentational: the input bar owns the textarea, the highlight index and the
 * keys, and calls `onSelect` with the chosen item.
 */
export function SlashCommandMenu({
  items,
  activeIndex,
  onSelect,
  onHighlight,
}: {
  items: readonly SlashMenuItem[];
  activeIndex: number;
  onSelect: (item: SlashMenuItem) => void;
  onHighlight: (index: number) => void;
}) {
  if (items.length === 0) return null;

  return (
    <div
      role="listbox"
      aria-label="Slash commands"
      className="bg-popover border-border absolute inset-x-3 bottom-full z-20 mb-2 overflow-hidden rounded-xl border p-1 shadow-lg"
    >
      {items.map((item, index) => {
        const Icon = item.icon;
        const active = index === activeIndex;
        const argument = item.kind === "argument" || item.kind === "value";
        return (
          <button
            key={`${item.kind}:${item.name}`}
            type="button"
            role="option"
            aria-selected={active}
            // Keep the caret in the textarea. the picker must not steal focus.
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => onHighlight(index)}
            onClick={() => onSelect(item)}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
              active ? "bg-accent/60" : "hover:bg-accent/60",
            )}
          >
            <Icon className="text-muted-foreground h-4 w-4 shrink-0" />
            <span className="shrink-0 font-mono text-sm font-medium">
              {argument ? item.name : `/${item.name}`}
              {item.kind === "argument" && item.name !== "files" ? ":" : ""}
            </span>
            {item.note ? (
              <span className="border-border/60 text-muted-foreground shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] tracking-wide uppercase">
                {item.note}
              </span>
            ) : null}
            {item.attached !== undefined ? (
              <span className="text-muted-foreground shrink-0 text-[11px]">
                {item.attached > 0 ? `${item.attached} attached` : "paperclip"}
              </span>
            ) : null}
            {item.hint ? (
              <span className="text-muted-foreground shrink-0 text-xs">{item.hint}</span>
            ) : null}
            <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
              {item.description}
            </span>
          </button>
        );
      })}
    </div>
  );
}
