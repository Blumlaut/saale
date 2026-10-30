/**
 * What a prompt row may hold, and which chats it belongs in.
 *
 * The settings form, the API routes, the composer's picker and the send paths
 * all read this, so a name the composer offers is a name the parser can find
 * again.
 */

import { getCommandMeta } from "@/lib/commands/catalog";

export const PROMPT_SCOPES = ["any", "chat", "coder"] as const;

export type PromptScope = (typeof PROMPT_SCOPES)[number];

export const PROMPT_SCOPE_LABELS: Record<PromptScope, string> = {
  any: "Any chat",
  chat: "Chats",
  coder: "Coder chats",
};

export const PROMPT_NAME_MAX = 40;
export const PROMPT_DESCRIPTION_MAX = 100;
export const PROMPT_ARGUMENT_HINT_MAX = 100;
export const PROMPT_CONTENT_MAX = 20_000;

/** Matches what the slash parser accepts after a `/`. */
export const PROMPT_NAME_PATTERN = /^[a-z0-9_-]+$/;

export function isPromptScope(value: unknown): value is PromptScope {
  return typeof value === "string" && (PROMPT_SCOPES as readonly string[]).includes(value);
}

/** Whether a user may give a prompt this name. */
export function isPromptName(value: string): boolean {
  return value.length > 0 && value.length <= PROMPT_NAME_MAX && PROMPT_NAME_PATTERN.test(value);
}

/** Whether a built-in command already answers to this name. */
export function isReservedPromptName(name: string): boolean {
  return getCommandMeta(name) !== undefined;
}

/** Whether a prompt of this scope is offered in a chat. */
export function promptScopeMatches(scope: PromptScope, isCoderChat: boolean): boolean {
  if (scope === "any") return true;
  return isCoderChat ? scope === "coder" : scope === "chat";
}
