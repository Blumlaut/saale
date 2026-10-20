import { Wrench } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { getToolCategory } from "@/lib/pi/tool-categories";
import { findToolInfo } from "@/lib/pi/tool-infos";

/** What the compact activity row shows for one call in place of a card. */
export type ToolMark = { kind: "favicon"; url: string } | { kind: "icon"; icon: LucideIcon };

/**
 * The mark a tool wears when nothing describes the call itself: its category's
 * icon, else the generic wrench.
 *
 * `toolMark` (the owner's descriptor-aware mark) falls back to this, and the
 * share page uses it outright. every shared call is redacted, so no descriptor
 * can ever read one. It lives here rather than in `tool-marks.ts` so importing
 * it does not drag the routing table and the owner's descriptors onto the share
 * surface (see `__tests__/share-redaction-coverage.test.ts`).
 */
export function categoryToolMark(toolName: string): ToolMark {
  const info = findToolInfo(toolName);
  return { kind: "icon", icon: getToolCategory(info?.category ?? "")?.icon ?? Wrench };
}
