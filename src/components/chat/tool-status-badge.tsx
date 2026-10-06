"use client";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { CheckCircle, AlertCircle, Loader2 } from "lucide-react";
import type { ToolCallData } from "./types";

/**
 * The running/completed/error badge shared by the generic tool call and the
 * codemode script card. Kept out of `tool-call-view.tsx` so the card modules it
 * imports can use it without a cycle.
 */
export function ToolStatusBadge({ toolCall }: { toolCall: ToolCallData }) {
  return (
    <Badge
      variant="secondary"
      className={cn(
        "ml-auto shrink-0 rounded-full px-1.5 py-0 text-[10px]",
        toolCall.status === "running" && "bg-yellow-500/10 text-yellow-600",
        toolCall.status === "completed" && "bg-green-500/10 text-green-600",
        (toolCall.status === "error" || toolCall.error) && "bg-red-500/10 text-red-600",
      )}
    >
      {toolCall.status === "running" && <Loader2 className="mr-1 h-2.5 w-2.5 animate-spin" />}
      {toolCall.status === "completed" && <CheckCircle className="mr-1 h-2.5 w-2.5" />}
      {(toolCall.status === "error" || toolCall.error) && (
        <AlertCircle className="mr-1 h-2.5 w-2.5" />
      )}
      {toolCall.status || (toolCall.error ? "error" : "done")}
    </Badge>
  );
}
