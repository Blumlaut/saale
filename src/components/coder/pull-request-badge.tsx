"use client";

import { GitMerge, GitPullRequest, GitPullRequestDraft } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The pull request a branch is on.
 *
 * The panel and the coder landing page both draw one, and they ask different
 * questions of it: the panel colours the forge's checks, the landing page
 * colours the request's own state, which is all a list row can afford to know.
 */

/** What a badge needs to know. A full `CoderPullRequest` satisfies it. */
export interface PullRequestBadgeData {
  number: number;
  /** OPEN, MERGED or CLOSED. */
  state: string;
  draft: boolean;
  url: string;
  title?: string | null;
  checks?: { passed: number; failed: number; pending: number } | null;
}

/** The colour a check rollup earns, in token pairs that read in both modes. */
function checksTone(checks: PullRequestBadgeData["checks"]): string {
  if (!checks) return "text-muted-foreground";
  if (checks.failed > 0) return "text-red-600 dark:text-red-400";
  if (checks.pending > 0) return "text-amber-600 dark:text-amber-400";
  return "text-emerald-600 dark:text-emerald-400";
}

/** Draft, open, merged, closed: grey, green, purple, red. */
export function pullRequestStateTone(
  pullRequest: Pick<PullRequestBadgeData, "state" | "draft">,
): string {
  if (pullRequest.draft) return "text-muted-foreground";
  switch (pullRequest.state.toUpperCase()) {
    case "MERGED":
      return "text-purple-600 dark:text-purple-400";
    case "CLOSED":
      return "text-destructive";
    default:
      return "text-emerald-600 dark:text-emerald-400";
  }
}

/** The word the badge says after the number. */
export function pullRequestStateLabel(
  pullRequest: Pick<PullRequestBadgeData, "state" | "draft">,
): string {
  return pullRequest.draft ? "draft" : pullRequest.state.toLowerCase();
}

/**
 * A pull request badge. A link when the forge gave it a URL, because its page
 * is the next stop; plain text otherwise.
 */
export function PullRequestBadge({
  pullRequest,
  tone = "checks",
  showState = false,
  className,
}: {
  pullRequest: PullRequestBadgeData;
  /** What the colour answers: the forge's checks, or the request's own state. */
  tone?: "checks" | "state";
  /** Say the state in words beside the number. */
  showState?: boolean;
  className?: string;
}) {
  const label = pullRequestStateLabel(pullRequest);
  const classes = cn(
    "inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[10px] tabular-nums",
    tone === "state" ? pullRequestStateTone(pullRequest) : checksTone(pullRequest.checks),
    pullRequest.url && "hover:bg-accent transition-colors",
    className,
  );
  const content = (
    <>
      {pullRequest.draft ? (
        <GitPullRequestDraft className="h-3 w-3" />
      ) : pullRequest.state.toUpperCase() === "MERGED" ? (
        <GitMerge className="h-3 w-3" />
      ) : (
        <GitPullRequest className="h-3 w-3" />
      )}
      #{pullRequest.number}
      {showState && <span>{label}</span>}
    </>
  );
  const title = pullRequest.title ? `${pullRequest.title} · ${label}` : undefined;

  return pullRequest.url ? (
    <a href={pullRequest.url} target="_blank" rel="noreferrer" title={title} className={classes}>
      {content}
    </a>
  ) : (
    <span title={title} className={classes}>
      {content}
    </span>
  );
}
