/**
 * Which prompts a chat offers, and what `/name args` expands to.
 *
 * Pure: the store, the project's template files and the composer all arrive as
 * `PromptEntry[]`, so precedence and expansion are decided in one place.
 */

import { parseCommand } from "@/lib/commands/parse";
import { parsePromptArgs, substitutePromptArgs } from "./substitute";
import { isPromptScope, promptScopeMatches } from "./rules";

/** A prompt as the picker and the sender see it. */
export interface PromptEntry {
  name: string;
  description: string;
  /** Pi's convention: `<required>` and `[optional]`. */
  argumentHint: string | null;
  content: string;
  /** Where it came from. The user's own rows win over a repo's files. */
  source: "user" | "project";
}

/** A prompt as the composer lists it. */
export type PromptPickerItem = Omit<PromptEntry, "content">;

/** What a `/name args` message expands to. */
export interface PromptMatch {
  entry: PromptEntry;
  content: string;
}

/** A stored prompt, with the scope that decides which chats it belongs to. */
export interface ScopedPrompt {
  name: string;
  description: string;
  argumentHint: string | null;
  /** `AppSettings`-style column value: one of `PROMPT_SCOPES`, or unset. */
  scope: string;
  content: string;
}

/** The user's prompts that belong in this chat. */
export function scopedPromptEntries(
  prompts: readonly ScopedPrompt[],
  isCoderChat: boolean,
): PromptEntry[] {
  return prompts
    .filter((prompt) =>
      promptScopeMatches(isPromptScope(prompt.scope) ? prompt.scope : "any", isCoderChat),
    )
    .map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      argumentHint: prompt.argumentHint,
      content: prompt.content,
      source: "user" as const,
    }));
}

/** Merge the sources in precedence order: the first prompt of a name owns it. */
export function mergePromptEntries(...lists: readonly (readonly PromptEntry[])[]): PromptEntry[] {
  const seen = new Set<string>();
  const merged: PromptEntry[] = [];
  for (const entry of lists.flat()) {
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    merged.push(entry);
  }
  return merged;
}

/** The composer's view: name, description and hint, in the given order. */
export function promptPickerItems(prompts: readonly PromptEntry[]): PromptPickerItem[] {
  return prompts.map(({ content: _content, ...item }) => item);
}

/**
 * Expand `/name args` against the prompts on offer, or null when the text names
 * no prompt.
 */
export function expandPrompt(text: string, prompts: readonly PromptEntry[]): PromptMatch | null {
  const parsed = parseCommand(text);
  if (!parsed) return null;
  const entry = prompts.find((prompt) => prompt.name === parsed.name);
  if (!entry) return null;
  return {
    entry,
    content: substitutePromptArgs(entry.content, parsePromptArgs(parsed.args)),
  };
}
