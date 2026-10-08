"use client";

import { CollapsedToolCalls } from "./collapsed-tool-calls";
import { ShowFileGallery } from "./file-card";
import { ToolCallView } from "./tool-call-view";
import { splitToolCalls } from "./tool-cards";
import type { ToolCallData } from "./types";

/**
 * The tool calls one turn made.
 *
 * A turn persists every call it made, so a step that reached for four tools
 * would otherwise stack four cards between two sentences — the work therefore
 * collapses into a single summary row, one click from the cards themselves.
 *
 * Files the agent *showed* the user are not work: they are the thing the user
 * is meant to look at, so they never fold away. One is its own attachment card,
 * several become a gallery.
 */
export function ToolCallGroup({ toolCalls }: { toolCalls: readonly ToolCallData[] }) {
  const { attachments, work } = splitToolCalls(toolCalls);

  return (
    <div className="space-y-1">
      <CollapsedToolCalls toolCalls={work} renderCall={ToolCallView} />

      {attachments.length === 1 ? (
        <ToolCallView toolCall={attachments[0]!} />
      ) : attachments.length > 1 ? (
        <ShowFileGallery toolCalls={attachments} />
      ) : null}
    </div>
  );
}
