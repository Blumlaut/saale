import type { ToolCallData } from "./types";

/**
 * Status vocabulary shared by every tool card.
 *
 * A card's badge always reports whether the call is running, succeeded or
 * failed. A card may supply a better *label* for a finished result ("exit 0",
 * "2 edits"), and. when the result knows better than the call's state. the
 * tone, but never a different status vocabulary.
 */
export type ToolStatusTone = "running" | "success" | "danger";

export interface ToolStatus {
  tone: ToolStatusTone;
  label: string;
}

const DEFAULT_LABEL: Record<ToolStatusTone, string> = {
  running: "running",
  success: "done",
  danger: "error",
};

/** The tone a call's own state implies; an error always wins. */
function toolStatusTone(toolCall: Pick<ToolCallData, "status" | "error">): ToolStatusTone {
  if (toolCall.error || toolCall.status === "error") return "danger";
  if (toolCall.status === "running") return "running";
  return "success";
}

/** Badge status for a tool call, with the card's own label and optional tone. */
export function toolStatus(
  toolCall: Pick<ToolCallData, "status" | "error">,
  label?: string,
  tone?: ToolStatusTone,
): ToolStatus {
  const resolvedTone = tone ?? toolStatusTone(toolCall);
  return { tone: resolvedTone, label: label ?? DEFAULT_LABEL[resolvedTone] };
}

/**
 * One badge for a run of calls: an error anywhere wins, then running, then done.
 *
 * A run that failed halfway has to say so. reporting a mixed run as "done"
 * would hide the failure behind a collapsed row.
 */
export function aggregateToolStatus(calls: readonly ToolCallData[]): ToolStatus {
  const failed = calls.some((call) => call.error || call.status === "error");
  const running = calls.some((call) => call.status === "running");
  return failed
    ? { tone: "danger", label: "failed" }
    : running
      ? { tone: "running", label: "running" }
      : { tone: "success", label: "done" };
}
