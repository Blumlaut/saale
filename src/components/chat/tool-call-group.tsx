"use client";

import { memo, useMemo } from "react";
import { CollapsedToolCalls } from "./collapsed-tool-calls";
import { ShowFileGallery } from "./file-card";
import { ToolCallView } from "./tool-call-view";
import { splitToolCalls } from "./tool-cards";
import type { ToolCallData } from "./types";

/**
 * The tool calls one turn made.
 *
 * A turn persists every call it made, so a step that reached for four tools
 * would otherwise stack four cards between two sentences. the work therefore
 * collapses into a single summary row, one click from the cards themselves.
 *
 * Files the agent *showed* the user are not work: they are the thing the user
 * is meant to look at, so they never fold away. One is its own attachment card,
 * several become a gallery. A rendered picture is an attachment too, and it
 * keeps its own card: the gallery reads `show_file` calls and would show a
 * render as an empty file.
 *
 * Memoized: a turn's `toolCalls` array lives as long as its message, so a token
 * in a later turn leaves every settled turn's cards alone.
 */
export const ToolCallGroup = memo(function ToolCallGroup({
  toolCalls,
}: {
  toolCalls: readonly ToolCallData[];
}) {
  const { attachments, work } = useMemo(() => splitToolCalls(toolCalls), [toolCalls]);

  // Only `show_file` calls tile: the gallery reads the file they shared.
  const shared = attachments.filter((call) => call.name === "show_file");
  const own = attachments.filter((call) => call.name !== "show_file");

  return (
    <div className="space-y-1">
      <CollapsedToolCalls toolCalls={work} renderCall={ToolCallView} />

      {own.map((call) => (
        <ToolCallView key={call.id} toolCall={call} />
      ))}

      {shared.length === 1 ? (
        <ToolCallView toolCall={shared[0]!} />
      ) : shared.length > 1 ? (
        <ShowFileGallery toolCalls={shared} />
      ) : null}
    </div>
  );
});
