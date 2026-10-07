import { Wrench } from "lucide-react";
import { findToolInfo } from "@/lib/pi/tool-infos";
import { truncate } from "@/lib/format";
import { formatToolArgs } from "../tool-args";
import { toolStatus } from "../tool-status";
import type { ToolCardModel } from "../tool-card-model";
import type { ToolCallData } from "../types";

/** Longest argument value shown beside a tool's name. */
const MAX_DETAIL = 60;
/** Longest name a tool outside the catalog gets to call itself. */
const MAX_UNKNOWN_TITLE = 32;
/** Result characters shown before truncating. */
const MAX_RESULT = 1000;

/**
 * The fallback card, for every tool without a descriptor of its own.
 *
 * It reads only a tool's name, arguments and result, so it is also what a
 * descriptor falls back to when a result carries nothing it understands — a
 * call showing its raw arguments beats a call that vanishes from the
 * transcript.
 */
export function describeGenericToolCall(toolCall: ToolCallData): ToolCardModel {
  const isError = Boolean(toolCall.error) || toolCall.status === "error";
  const args = formatToolArgs(toolCall.args);
  const result = toolCall.result;
  const detail = primaryArg(toolCall.args);

  const info = findToolInfo(toolCall.name);

  return {
    icon: Wrench,
    // The header never truncates a title, so a tool the catalog does not know
    // is capped here rather than allowed to squeeze the row.
    title: info?.label ?? truncate(toolCall.name, MAX_UNKNOWN_TITLE),
    ...(detail ? { detail } : {}),
    status: toolStatus(toolCall),
    // A failure's reason is the whole point of the card, so never hide it.
    ...(isError ? { defaultOpen: true } : {}),
    blocks: [
      ...(args ? [{ kind: "code" as const, text: args, label: "Arguments" }] : []),
      ...(result
        ? [
            {
              kind: "code" as const,
              text: result,
              label: isError ? "Error" : "Result",
              ...(isError ? { tone: "danger" as const } : {}),
              max: MAX_RESULT,
            },
          ]
        : []),
    ],
  };
}

/** The first argument worth showing beside a tool's name, as one line. */
function primaryArg(args: Record<string, unknown>): string | undefined {
  for (const value of Object.values(args)) {
    if (typeof value === "string" && value.trim()) {
      return truncate(value.trim().replace(/\s+/g, " "), MAX_DETAIL);
    }
  }
  return undefined;
}
