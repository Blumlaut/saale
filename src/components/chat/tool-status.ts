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
  if (toolCall.status === "pending" || toolCall.status === "running") return "running";
  return "success";
}

/**
 * Whether the call has not finished yet: its arguments are still being written,
 * or it is executing. Descriptors ask this rather than comparing to `running`,
 * so a call that has not run yet is never mistaken for a finished one.
 */
export function isToolCallInProgress(toolCall: Pick<ToolCallData, "status">): boolean {
  return toolCall.status === "pending" || toolCall.status === "running";
}

/**
 * Badge status for a tool call, with the card's own label and optional tone.
 *
 * A call whose arguments are still being written says so: its spinner reports
 * the turn is alive either way, but "running" would claim work that has not
 * started.
 */
export function toolStatus(
  toolCall: Pick<ToolCallData, "status" | "error">,
  label?: string,
  tone?: ToolStatusTone,
): ToolStatus {
  const resolvedTone = tone ?? toolStatusTone(toolCall);
  if (label) return { tone: resolvedTone, label };
  if (toolCall.status === "pending") return { tone: resolvedTone, label: "preparing" };
  return { tone: resolvedTone, label: DEFAULT_LABEL[resolvedTone] };
}

/**
 * One badge for a run of calls: an error anywhere wins, then running, then done.
 *
 * A run that failed halfway has to say so. reporting a mixed run as "done"
 * would hide the failure behind a collapsed row.
 */
export function aggregateToolStatus(calls: readonly ToolCallData[]): ToolStatus {
  const failed = calls.some((call) => call.error || call.status === "error");
  const running = calls.some(isToolCallInProgress);
  return failed
    ? { tone: "danger", label: "failed" }
    : running
      ? { tone: "running", label: "running" }
      : { tone: "success", label: "done" };
}
