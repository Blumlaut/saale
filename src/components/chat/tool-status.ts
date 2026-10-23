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
 * One badge for a run of calls: work in progress wins, then an error, then done.
 *
 * A run that failed halfway has to say so. reporting a mixed run as "done"
 * would hide the failure behind a collapsed row. But a run that is still going
 * says that instead: a call that is executing (or still having its arguments
 * written) is what the run is doing right now, and freezing the badge on a
 * failure from three calls ago makes a live run look finished.
 */
export function aggregateToolStatus(calls: readonly ToolCallData[]): ToolStatus {
  const inProgress = calls.some(isToolCallInProgress);
  const failed = calls.some((call) => call.error || call.status === "error");
  return inProgress
    ? { tone: "running", label: "running" }
    : failed
      ? { tone: "danger", label: "failed" }
      : { tone: "success", label: "done" };
}
