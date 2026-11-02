import brand from "@/lib/pwa/brand.json";

/**
 * The name this instance shows.
 *
 * One value feeds the wordmark, the browser title, the app manifest, shared
 * chats and the calendar export, so an admin renames the instance once. An
 * empty setting keeps the built-in name.
 */

export const DEFAULT_WORKSPACE_NAME = brand.name;

/** The wordmark has one line to spend, so the name stops here. */
export const MAX_WORKSPACE_NAME_LENGTH = 40;

/** The stored name, or the built-in one when the admin left it empty. */
export function normalizeWorkspaceName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) return DEFAULT_WORKSPACE_NAME;
  return name.slice(0, MAX_WORKSPACE_NAME_LENGTH);
}
