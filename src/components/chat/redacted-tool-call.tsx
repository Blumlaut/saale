"use client";

import { memo } from "react";
import { findToolInfo, toolIcon } from "@/lib/pi/tool-infos";
import { ImageFrame } from "./image-tile";
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
 *
 * The one thing a share shows of a result is a rendered picture. Its URL comes
 * from the share endpoint, which resolves the file from that call's own result
 * in the session, so a shared page holds no workspace path at all.
 */
export const RedactedToolCall = memo(function RedactedToolCall({
  toolCall,
}: {
  toolCall: ToolCallData;
}) {
  const label = findToolInfo(toolCall.name)?.label ?? toolCall.name;
  const Icon = toolIcon(toolCall.name);

  return (
    <div className="bg-muted border-border rounded-xl border">
      <div className="flex items-center gap-2 px-3 py-2">
        <Icon className="text-muted-foreground h-3 w-3 shrink-0" />
        <span className="shrink-0 text-xs font-medium">{label}</span>
        <span className="text-muted-foreground min-w-0 truncate text-[11px]">
          {toolCall.redacted}
        </span>
        <ToolStatusBadge status={toolStatus(toolCall)} />
      </div>
      {toolCall.image && (
        <div className="px-3 pb-3">
          <ImageFrame width={toolCall.image.width} height={toolCall.image.height}>
            {/* eslint-disable-next-line @next/next/no-img-element -- served by the share endpoint */}
            <img
              src={toolCall.image.src}
              alt={label}
              loading="lazy"
              className="h-full w-full object-contain"
            />
          </ImageFrame>
        </div>
      )}
    </div>
  );
});
