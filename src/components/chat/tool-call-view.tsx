"use client";

import { memo } from "react";
import { RedactedToolCall } from "./redacted-tool-call";
import { resolveToolCard } from "./tool-cards";
import type { ToolCallData } from "./types";

/**
 * Renders one tool call with the card its route provides. see `./tool-cards`
 * for the routing table and how a card is described.
 *
 * The `redacted` check is a second line of defence for any caller handed a
 * share payload: it fires before a card below can read `args` or `result` (and
 * before a `show_file` card can fetch a file).
 */
export const ToolCallView = memo(function ToolCallView({ toolCall }: { toolCall: ToolCallData }) {
  if (toolCall.redacted) return <RedactedToolCall toolCall={toolCall} />;

  const Card = resolveToolCard(toolCall.name);
  return <Card toolCall={toolCall} />;
});
