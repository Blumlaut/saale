"use client";

import { memo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Code2, ChevronDown, ChevronRight } from "lucide-react";
import { findToolInfo } from "@/lib/pi/tool-infos";
import { extractScriptToolNames, formatToolArgs } from "./tool-args";
import { ToolStatusBadge } from "./tool-status-badge";
import type { ToolCallData } from "./types";

/** A tool's display label, falling back to its script identifier. */
function toolLabel(name: string): string {
  return findToolInfo(name)?.label ?? name;
}

/**
 * Renders a codemode call.
 *
 * Codemode batches several tool calls into one script, and only the script is
 * declared to the model — so this card is the user's only view of what
 * happened: which tools the script reached, the script itself, and its output.
 */
export const CodemodeToolCard = memo(function CodemodeToolCard({
  toolCall,
}: {
  toolCall: ToolCallData;
}) {
  const [expanded, setExpanded] = useState(false);

  const code = typeof toolCall.args.code === "string" ? toolCall.args.code : "";
  const calledTools = extractScriptToolNames(code);
  const isError = toolCall.status === "error" || !!toolCall.error;

  return (
    <div className="liquid-glass-inner rounded-xl">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        onClick={() => setExpanded((prev) => !prev)}
      >
        {expanded ? (
          <ChevronDown className="text-muted-foreground h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="text-muted-foreground h-3 w-3 shrink-0" />
        )}
        <Code2 className="text-muted-foreground h-3 w-3 shrink-0" />
        <span className="shrink-0 text-xs font-medium">Script</span>
        {calledTools.length > 0 && (
          <span className="text-muted-foreground min-w-0 truncate text-[11px]">
            {calledTools.map(toolLabel).join(" · ")}
          </span>
        )}
        <ToolStatusBadge toolCall={toolCall} />
      </button>

      {expanded && (
        <div className="border-border/30 space-y-2 border-t px-3 py-2">
          <p className="text-muted-foreground text-xs">
            Saale batches tool calls into a script so one step can call several tools and keep only
            the result.
          </p>

          {calledTools.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {calledTools.map((name) => (
                <Badge
                  key={name}
                  variant="secondary"
                  className="rounded-md px-1.5 py-0 text-[10px] font-normal"
                >
                  {toolLabel(name)}
                </Badge>
              ))}
            </div>
          )}

          <div className="text-muted-foreground text-xs font-medium">Script</div>
          <pre className="bg-muted overflow-x-auto rounded-lg p-2 font-mono text-xs break-words whitespace-pre-wrap">
            {code || formatToolArgs(toolCall.args)}
          </pre>

          {toolCall.result && (
            <>
              <div className="text-muted-foreground text-xs font-medium">
                {isError ? "Error" : "Output"}
              </div>
              <pre
                className={
                  isError
                    ? "overflow-x-auto rounded-lg bg-red-500/10 p-2 text-xs break-words whitespace-pre-wrap text-red-600 dark:text-red-400"
                    : "bg-muted overflow-x-auto rounded-lg p-2 text-xs break-words whitespace-pre-wrap"
                }
              >
                {toolCall.result.slice(0, 1000)}
                {toolCall.result.length > 1000 && "..."}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
});
