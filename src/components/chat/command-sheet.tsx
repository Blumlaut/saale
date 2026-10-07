"use client";

import { useEffect, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CommandPrompt } from "@/lib/commands/types";

/** Prompts longer than this get a filter box (the model list, mainly). */
const SEARCH_THRESHOLD = 6;

/**
 * The web surface's rendering of an interactive command's prompt.
 *
 * A command declares *what* it offers (`CommandPrompt`); this decides how a
 * choice is presented on the web. Telegram renders the same prompt as an
 * inline keyboard.
 */
export function CommandSheet({
  open,
  onOpenChange,
  prompt,
  busy,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prompt: CommandPrompt | null;
  busy: boolean;
  onSelect: (value: string) => void;
}) {
  const [filter, setFilter] = useState("");

  // A new prompt starts with a clean filter.
  useEffect(() => {
    setFilter("");
  }, [prompt]);

  const options = prompt?.options ?? [];
  const term = filter.trim().toLowerCase();
  const visible = term
    ? options.filter(
        (option) =>
          option.label.toLowerCase().includes(term) || option.value.toLowerCase().includes(term),
      )
    : options;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex flex-col overflow-hidden p-0">
        <div className="relative flex min-h-0 flex-1 flex-col">
          <SheetHeader className="border-border/30 shrink-0 border-b px-4 pt-4 pb-3">
            <SheetTitle className="text-base leading-tight font-semibold">
              {prompt?.title ?? "Command"}
            </SheetTitle>
            {prompt?.description && (
              <SheetDescription className="text-muted-foreground text-xs">
                {prompt.description}
              </SheetDescription>
            )}
          </SheetHeader>

          {options.length > SEARCH_THRESHOLD && (
            <div className="shrink-0 px-4 pt-3">
              <Input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter…"
                aria-label="Filter options"
              />
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {visible.length === 0 ? (
              <p className="text-muted-foreground px-3 py-6 text-center text-sm">
                {options.length === 0 ? "Nothing is available yet." : "Nothing matches."}
              </p>
            ) : (
              <ul className="grid grid-cols-1 gap-1">
                {visible.map((option) => (
                  <li key={option.value}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onSelect(option.value)}
                      className={cn(
                        "hover:bg-accent/60 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
                        "disabled:pointer-events-none disabled:opacity-50",
                        option.current && "bg-accent/40",
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{option.label}</span>
                        {option.description && (
                          <span className="text-muted-foreground block text-xs">
                            {option.description}
                          </span>
                        )}
                      </span>
                      {option.current && <Check className="text-primary h-4 w-4 shrink-0" />}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {busy && (
            <div className="bg-background/40 absolute inset-0 flex items-center justify-center">
              <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
