import { Wrench } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { getToolCategory } from "@/lib/pi/tool-categories";
import { findToolInfo } from "@/lib/pi/tool-infos";
import { describeToolCard } from "./tool-cards";
import { webFetchFaviconUrl } from "./tool-descriptors/web";
import type { ToolCallData } from "./types";

/** What the compact activity row shows for one call in place of a card. */
export type ToolMark = { kind: "favicon"; url: string } | { kind: "icon"; icon: LucideIcon };

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

  return { kind: "icon", icon: toolIcon(toolCall) };
}

/** The call's card icon, else its category's, else the generic wrench. */
function toolIcon(toolCall: ToolCallData): LucideIcon {
  const described = describeToolCard(toolCall.name, toolCall);
  if (described) return described.icon;

  const info = findToolInfo(toolCall.name);
  return getToolCategory(info?.category ?? "")?.icon ?? Wrench;
}
