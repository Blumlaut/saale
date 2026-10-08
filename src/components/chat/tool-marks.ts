import { categoryToolMark, type ToolMark } from "./tool-mark-model";
import { describeToolCard } from "./tool-cards";
import { webFetchFaviconUrl } from "./tool-descriptors/web";
import type { ToolCallData } from "./types";

export type { ToolMark };

/**
 * The mark for one call: the site's own favicon when the call opened a page,
 * otherwise the call's icon.
 *
 * A favicon beats an icon for a fetch because a run of fetches is a list of
 * *places* the turn read — the site is the identity, and every fetch card
 * already leads with it. The icon comes from the call's own descriptor, so a
 * tool never wears a different mark in the compact row than on its card.
 */
export function toolMark(toolCall: ToolCallData): ToolMark {
  if (toolCall.name === "web_fetch") {
    const url = webFetchFaviconUrl(toolCall);
    if (url) return { kind: "favicon", url };
  }

  const described = describeToolCard(toolCall.name, toolCall);
  return described ? { kind: "icon", icon: described.icon } : categoryToolMark(toolCall.name);
}
