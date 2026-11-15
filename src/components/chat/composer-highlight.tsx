"use client";

import { cn } from "@/lib/utils";
import type { CommandToken } from "@/lib/commands/highlight";

/** How each run is painted behind the composer's text. */
const TOKEN_CLASSES: Record<CommandToken["kind"], string> = {
  command: "rounded bg-primary/15 text-transparent",
  label: "rounded bg-primary/20 font-medium text-transparent",
  value: "rounded bg-muted-foreground/20 text-transparent",
  plain: "text-transparent",
};

/**
 * The wash behind a command being typed.
 *
 * A textarea cannot colour part of its own text, so this renders the same
 * string in invisible glyphs underneath it with a background per run. Both
 * layers share their font, padding and leading, so the chips land on the words
 * they describe. Purely decorative, and never interactive.
 */
export function ComposerHighlight({
  tokens,
  className,
  ref,
}: {
  tokens: readonly CommandToken[];
  className?: string;
  ref?: React.Ref<HTMLDivElement>;
}) {
  if (tokens.length === 0) return null;

  return (
    <div
      ref={ref}
      aria-hidden
      data-slot="composer-highlight"
      className={cn(
        "pointer-events-none absolute inset-0 overflow-hidden select-none",
        "text-[16px] leading-6 break-words whitespace-pre-wrap md:text-sm",
        className,
      )}
    >
      {tokens.map((token, index) => (
        <span key={index} data-kind={token.kind} className={TOKEN_CLASSES[token.kind]}>
          {token.text}
        </span>
      ))}
    </div>
  );
}
