"use client";

import type { ComponentType } from "react";
import { Layers } from "lucide-react";
import { findToolInfo } from "@/lib/pi/tool-infos";
import { plural } from "@/lib/format";
import { ToolCard } from "./tool-card";
import { aggregateToolStatus } from "./tool-status";
import type { ToolCallData } from "./types";

/** How one call in a run renders — the owner's card, or the redacted one. */
export type ToolCallRenderer = ComponentType<{ toolCall: ToolCallData }>;

/**
 * The collapsed tool view, shared by the transcript and the public share page.
 *
 * A turn persists every call it made, so a step that reached for four tools
 * would otherwise stack four rows between two sentences. A lone call stands on
 * its own; several fold into a summary row that opens to the individual calls.
 *
 * The caller supplies `renderCall`, which is the only difference between the
 * two surfaces: the transcript passes `ToolCallView` (the owner's cards), the
 * share viewer passes `RedactedToolCall`. Keeping the collapse here — rather
 * than in `ToolCallGroup`, which pulls in the owner's cards — is what lets a
 * share page fold a run without an owner card becoming reachable from it (see
 * `__tests__/share-redaction-coverage.test.ts`).
 */
export function CollapsedToolCalls({
  toolCalls,
  renderCall: RenderCall,
}: {
  toolCalls: readonly ToolCallData[];
  renderCall: ToolCallRenderer;
}) {
  if (toolCalls.length === 0) return null;
  if (toolCalls.length === 1) return <RenderCall toolCall={toolCalls[0]!} />;

  return (
    <ToolCard
      model={{
        icon: Layers,
        title: plural(toolCalls.length, "tool call", "tool calls"),
        detail: toolCalls.map((call) => findToolInfo(call.name)?.label ?? call.name).join(" · "),
        status: aggregateToolStatus(toolCalls),
      }}
    >
      {toolCalls.map((toolCall) => (
        <RenderCall key={toolCall.id} toolCall={toolCall} />
      ))}
    </ToolCard>
  );
}
