/**
 * What a session is told about where search runs.
 *
 * The tool's parameter descriptions are the same for every deployment, and the
 * instance's category names are not. `GET /config` has them, so the prompt
 * names the ones this instance answers to.
 */

import { isCategoryEnabled } from "@/lib/pi/tool-categories";
import { readSearchInstance } from "@/lib/web/instance";
import { readWebTools } from "@/lib/web/tool-settings";

export interface SearchSources {
  /** Category names the instance answers to. Empty when it could not be read. */
  categories: string[];
  /** Categories a search draws from when it names none. */
  defaults: string[];
  /** Engines a search may use. Empty when the operator allows every engine. */
  engines: string[];
}

/** The instance's categories, and the sources the operator configured. */
export async function readSearchSources(): Promise<SearchSources> {
  const [{ search }, instance] = await Promise.all([readWebTools(), readSearchInstance()]);
  return {
    categories: instance?.categories ?? [],
    defaults: [...search.categories],
    engines: [...search.engines],
  };
}

/**
 * The sources a session's prompt can name, or nothing when it has no web tools
 * or the read fails. A prompt that loses its category names is worth more than
 * a chat that will not start.
 */
export async function promptSearchSources(
  toolConfig: Record<string, boolean | undefined> | null | undefined,
): Promise<SearchSources | undefined> {
  if (!isCategoryEnabled(toolConfig, "web")) return undefined;
  try {
    return await readSearchSources();
  } catch (err) {
    console.error("Failed to read the search sources for the prompt:", err);
    return undefined;
  }
}
