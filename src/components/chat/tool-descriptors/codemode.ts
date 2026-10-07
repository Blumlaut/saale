import { Code2 } from "lucide-react";
import { findToolInfo } from "@/lib/pi/tool-infos";
import { extractScriptToolNames, formatToolArgs } from "../tool-args";
import { toolStatus } from "../tool-status";
import type { ToolCardModel, ToolDescriptor } from "../tool-card-model";

/** Script or output characters shown before truncating. */
const MAX_RESULT = 1000;

/** A tool's display label, falling back to its script identifier. */
function toolLabel(name: string): string {
  return findToolInfo(name)?.label ?? name;
}

/**
 * Codemode batches several tool calls into one script, and only the script is
 * declared to the model — so this card is the user's only view of what
 * happened: which tools the script reached, the script itself, and its output.
 */
export const codemodeDescriptor: ToolDescriptor = {
  names: ["codemode"],
  describe(toolCall): ToolCardModel {
    const code = typeof toolCall.args.code === "string" ? toolCall.args.code : "";
    const calledTools = extractScriptToolNames(code);
    const isError = Boolean(toolCall.error) || toolCall.status === "error";

    return {
      icon: Code2,
      title: "Script",
      ...(calledTools.length > 0 ? { detail: calledTools.map(toolLabel).join(" · ") } : {}),
      status: toolStatus(toolCall),
      blocks: [
        {
          kind: "text",
          text: "Saale batches tool calls into a script so one step can call several tools and keep only the result.",
        },
        ...(calledTools.length > 0
          ? [{ kind: "badges" as const, items: calledTools.map(toolLabel) }]
          : []),
        {
          kind: "code",
          text: code || formatToolArgs(toolCall.args),
          label: "Script",
        },
        ...(toolCall.result
          ? [
              {
                kind: "code" as const,
                text: toolCall.result,
                label: isError ? "Error" : "Output",
                ...(isError ? { tone: "danger" as const } : {}),
                max: MAX_RESULT,
              },
            ]
          : []),
      ],
    };
  },
};
