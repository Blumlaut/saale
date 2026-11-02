/**
 * Tool categories a coder chat starts with.
 *
 * A coder chat works in a worktree: the shell, file editing and memory are the
 * whole job. Everything else (mail, calendar, jobs, the app's own tools) would
 * be context the work does not use, so it starts off and the user turns back on
 * whatever a given project needs.
 */

import { TOOL_CATEGORIES, type ToolCategoryKey } from "./tool-categories";
import type { ToolPolicy } from "./tool-infos";

/**
 * Categories a coder chat starts with, on top of the worktree tools.
 *
 * `settings` is here for the project's own: a chat runs in one checkout, and the
 * env files every checkout inherits are set on the project, so the agent that
 * finds one missing is the one that should fix it for the next chat.
 */
const CODER_CATEGORIES_ON: readonly ToolCategoryKey[] = ["terminal", "web", "memory", "settings"];

/** Default on/off per category for a new coder chat. */
export const CODER_TOOL_DEFAULTS: Record<ToolCategoryKey, boolean> = Object.fromEntries(
  TOOL_CATEGORIES.map((category) => [category.key, CODER_CATEGORIES_ON.includes(category.key)]),
) as Record<ToolCategoryKey, boolean>;

/**
 * Approval policies a new coder chat starts from.
 *
 * Writing and editing files is what a coder chat is for, so the two tools that
 * otherwise ask stand open here. A policy the user set still wins, and `off`
 * stays off.
 */
const CODER_POLICY_DEFAULTS: Record<string, ToolPolicy> = {
  write: "allow",
  edit: "allow",
};

/**
 * A coder chat's approval policies: the coder defaults, with the user's own
 * choices on top.
 */
export function resolveCoderToolPolicies(
  stored: Record<string, string> | null | undefined,
): Record<string, string> {
  return { ...CODER_POLICY_DEFAULTS, ...stored };
}

/**
 * A coder chat's tool config: the stored setting where it names a category, the
 * coder default where it does not.
 *
 * Stored sparse (only what the user changed), so a category added later follows
 * `CODER_TOOL_DEFAULTS` instead of staying off for everyone.
 */
export function resolveCoderToolConfig(
  stored: Record<string, unknown> | null | undefined,
): Record<ToolCategoryKey, boolean> {
  const config = { ...CODER_TOOL_DEFAULTS };
  for (const category of TOOL_CATEGORIES) {
    const entry = stored?.[category.key];
    if (typeof entry === "boolean") config[category.key] = entry;
  }
  return config;
}
