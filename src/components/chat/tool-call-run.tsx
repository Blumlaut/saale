"use client";

import { Layers } from "lucide-react";
import { findToolInfo } from "@/lib/pi/tool-infos";
import { plural } from "@/lib/format";
import { ToolCard } from "./tool-card";
import { ToolCallView } from "./tool-call-view";
import type { ToolStatus } from "./tool-status";
import type { ToolCallData } from "./types";

/**
 * The tool calls one turn made in parallel, collapsed into a single row.
 *
 * A turn persists every tool call it made, so a step that reached for four
 * tools would otherwise stack four cards between two sentences. The cards are
 * still there, one click down — this is just the summary line.
 */
export function ToolCallRun({ toolCalls }: { toolCalls: readonly ToolCallData[] }) {
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
