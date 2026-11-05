"use client";

import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { PROMPT_SCOPE_LABELS, type PromptScope } from "@/lib/prompts/rules";

/** The columns a prompt row shows, from either table. */
export interface PromptRowData {
  id: string;
  name: string;
  description: string;
  argumentHint: string | null;
  scope: PromptScope;
  /** Written by an admin for the whole instance. */
  shared?: boolean;
}

/**
 * One prompt in a list: its `/name`, where it is offered, and what it does.
 *
 * The user's settings section and the admin's shared-prompt page render the
 * same row, so the actions come from the page: a shared prompt has none in the
 * user's section.
 */
export function PromptRow({ prompt, actions }: { prompt: PromptRowData; actions?: ReactNode }) {
  return (
    <div className="hover:bg-accent/60 flex items-center gap-3 px-4 py-3 transition-colors duration-150 md:px-6">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-mono text-sm font-medium">/{prompt.name}</span>
          {prompt.argumentHint ? (
            <span className="text-muted-foreground truncate text-xs">{prompt.argumentHint}</span>
          ) : null}
          <Badge variant="secondary" className="rounded-full px-2 py-0 text-[10px]">
            {PROMPT_SCOPE_LABELS[prompt.scope] ?? "Any chat"}
          </Badge>
          {prompt.shared ? (
            <Badge variant="outline" className="rounded-full px-2 py-0 text-[10px]">
              Shared
            </Badge>
          ) : null}
        </div>
        <p className="text-muted-foreground mt-1 truncate text-xs">{prompt.description}</p>
      </div>

      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  );
}
