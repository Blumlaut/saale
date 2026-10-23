/**
 * Tool categories a coder chat starts with.
 *
 * A coder chat works in a worktree: the shell, file editing and memory are the
 * whole job. Everything else (mail, calendar, jobs, the app's own tools) would
 * be context the work does not use, so it starts off and the user turns back on
 * whatever a given project needs.
 */

import { TOOL_CATEGORIES, type ToolCategoryKey } from "./tool-categories";

/** Categories a coder chat starts with, on top of the worktree tools. */
const CODER_CATEGORIES_ON: readonly ToolCategoryKey[] = ["terminal", "web", "memory"];

/** Default on/off per category for a new coder chat. */
export const CODER_TOOL_DEFAULTS: Record<ToolCategoryKey, boolean> = Object.fromEntries(
  TOOL_CATEGORIES.map((category) => [category.key, CODER_CATEGORIES_ON.includes(category.key)]),
) as Record<ToolCategoryKey, boolean>;

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
