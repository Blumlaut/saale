"use client";

import { Layers } from "lucide-react";
import { findToolInfo } from "@/lib/pi/tool-infos";
import { plural } from "@/lib/format";
import { ShowFileGallery } from "./file-card";
import { ToolCard } from "./tool-card";
import { ToolCallView } from "./tool-call-view";
import { splitToolCalls } from "./tool-cards";
import type { ToolStatus } from "./tool-status";
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
      {work.length === 1 ? (
        <ToolCallView toolCall={work[0]!} />
      ) : work.length > 1 ? (
        <CollapsedWork toolCalls={work} />
      ) : null}

      {attachments.length === 1 ? (
        <ToolCallView toolCall={attachments[0]!} />
      ) : attachments.length > 1 ? (
        <ShowFileGallery toolCalls={attachments} />
      ) : null}
    </div>
  );
}

/** The summary row: what the turn did, with its cards one click down. */
function CollapsedWork({ toolCalls }: { toolCalls: readonly ToolCallData[] }) {
  const failed = toolCalls.some((call) => call.error || call.status === "error");
  const running = toolCalls.some((call) => call.status === "running");
  const status: ToolStatus = failed
    ? { tone: "danger", label: "failed" }
    : running
      ? { tone: "running", label: "running" }
      : { tone: "success", label: "done" };

  return (
    <ToolCard
      model={{
        icon: Layers,
        title: plural(toolCalls.length, "tool call", "tool calls"),
        detail: toolCalls.map((call) => findToolInfo(call.name)?.label ?? call.name).join(" · "),
        status,
      }}
    >
      {toolCalls.map((toolCall) => (
        <ToolCallView key={toolCall.id} toolCall={toolCall} />
      ))}
    </ToolCard>
  );
}
