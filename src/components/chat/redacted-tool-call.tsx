"use client";

import { memo } from "react";
import { findToolInfo, toolIcon } from "@/lib/pi/tool-infos";
import { ToolStatusBadge } from "./tool-status-badge";
import { toolStatus } from "./tool-status";
import type { ToolCallData } from "./types";

/**
 * The only tool card a public share page can render.
 *
 * A redacted call arrives with its arguments and result already stripped by the
 * share endpoints, so there is nothing here to read but the tool's name and the
 * server-written summary. no meta block to parse, no file to fetch.
 * `ShareViewer` renders this and nothing else, so a card built for the owner's
 * data cannot reach a share page: `__tests__/share-redaction-coverage.test.ts`
 * keeps every raw card module out of the share surface.
 */
export const RedactedToolCall = memo(function RedactedToolCall({
  toolCall,
}: {
  toolCall: ToolCallData;
}) {
  const label = findToolInfo(toolCall.name)?.label ?? toolCall.name;
  const Icon = toolIcon(toolCall.name);

  return (
    <div className="liquid-glass-inner rounded-xl">
      <div className="flex items-center gap-2 px-3 py-2">
        <Icon className="text-muted-foreground h-3 w-3 shrink-0" />
        <span className="shrink-0 text-xs font-medium">{label}</span>
        <span className="text-muted-foreground min-w-0 truncate text-[11px]">
          {toolCall.redacted}
        </span>
        <ToolStatusBadge status={toolStatus(toolCall)} />
      </div>
    </div>
  );
});
