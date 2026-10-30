/**
 * The pull request a chat's branch has, through `gh`.
 *
 * `gh` is already in the sandbox image and the user's own login (or `GH_TOKEN`
 * among their sandbox variables) is what answers, so the panel never holds a
 * token of its own. A repo with no pull request, no `gh`, or no network is not
 * an error here: the panel shows the branch without a badge, which is what it
 * shows on a repo that has never had one.
 */

import { checkoutOf } from "./checkout";
import { loadCoderSession } from "./changes";
import { runInWorkspace, shellQuote } from "./git";
import { resolveSandboxEnv } from "@/lib/sandbox/env";

/** A question about a branch: short, and the panel can ask again later. */
const VIEW_TIMEOUT_SECONDS = 30;

/** Opening a pull request talks to the forge for longer. */
const CREATE_TIMEOUT_SECONDS = 60;

/** The check counts a badge shows, whatever kind of check they came from. */
export interface PullRequestChecks {
  passed: number;
  failed: number;
  pending: number;
}

/** One pull request, as the panel needs it. */
export interface CoderPullRequest {
  number: number;
  title: string;
  /** OPEN, MERGED or CLOSED. */
  state: string;
  url: string;
  draft: boolean;
  /** The forge's review answer, e.g. APPROVED. Null when nobody reviewed. */
  reviewDecision: string | null;
  checks: PullRequestChecks | null;
}

/** The chat's checkout and the token `gh` should use, or null when it has none. */
async function ghTarget(
  userId: string,
  sessionId: string,
): Promise<{ dir: string; env: Record<string, string> } | null> {
  const session = await loadCoderSession(userId, sessionId);
  if (!session) return null;
  const checkout = checkoutOf(session);
  if (!checkout) return null;

  const sandboxEnv: Record<string, string> = await resolveSandboxEnv(userId).catch(
    (err: unknown) => {
      console.error(`Failed to load sandbox variables for gh in ${checkout.path}:`, err);
      return {};
    },
  );
  const token = sandboxEnv.GH_TOKEN;
  return { dir: checkout.path, env: token ? { GH_TOKEN: token } : {} };
}

/** The `state` or `conclusion` of one entry in a status check rollup. */
function checkOutcome(entry: Record<string, unknown>): "passed" | "failed" | "pending" {
  const verdict = String(entry.conclusion ?? entry.state ?? "").toUpperCase();
  if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(verdict)) return "passed";
  if (
    ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(
      verdict,
    )
  ) {
    return "failed";
  }
  return "pending";
}

/** The rollup as three counts, or null when the pull request ran no checks. */
function countChecks(rollup: unknown): PullRequestChecks | null {
  if (!Array.isArray(rollup) || rollup.length === 0) return null;
  const counts: PullRequestChecks = { passed: 0, failed: 0, pending: 0 };
  for (const entry of rollup) {
    if (!entry || typeof entry !== "object") continue;
    counts[checkOutcome(entry as Record<string, unknown>)] += 1;
  }
  return counts;
}

/**
 * The pull request the checkout's branch is on, or null when it has none.
 *
 * Every failure reads as "no pull request": a project whose remote is not a
 * forge, a branch never pushed, and a token without the scope all end the same
 * way, and none of them should put an error in a panel that is otherwise fine.
 */
export async function readPullRequest(
  userId: string,
  sessionId: string,
): Promise<CoderPullRequest | null> {
  const target = await ghTarget(userId, sessionId);
  if (!target) return null;

  const result = await runInWorkspace(userId, {
    cwd: target.dir,
    command: "gh pr view --json number,title,state,url,isDraft,reviewDecision,statusCheckRollup",
    env: target.env,
    timeoutSeconds: VIEW_TIMEOUT_SECONDS,
  });
  if (result.exitCode !== 0) {
    // gh says "no pull requests found" here, which is not a failure to report.
    const message = result.stderr.trim();
    if (!/no pull requests found|not a git repository|no remotes/i.test(message)) {
      console.warn(`[coder] gh could not read the pull request for ${target.dir}: ${message}`);
    }
    return null;
  }

  const parsed = parsePullRequest(result.stdout);
  return parsed;
}

/** `gh pr view --json` output as a pull request, or null when it is not one. */
export function parsePullRequest(stdout: string): CoderPullRequest | null {
  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  const number = Number(value.number);
  if (!Number.isFinite(number) || number <= 0) return null;

  return {
    number,
    title: String(value.title ?? ""),
    state: String(value.state ?? "OPEN"),
    url: String(value.url ?? ""),
    draft: value.isDraft === true,
    reviewDecision: typeof value.reviewDecision === "string" ? value.reviewDecision : null,
    checks: countChecks(value.statusCheckRollup),
  };
}

/** Why opening a pull request failed, in words the panel can show. */
export class PullRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PullRequestError";
  }
}

/**
 * Open a pull request for the branch, filled from its commits.
 *
 * `--fill` is what makes this one click: the title comes from the branch's first
 * commit and the body from the rest, and the user edits it on the forge.
 */
export async function createPullRequest(
  userId: string,
  sessionId: string,
  options: { draft: boolean },
): Promise<CoderPullRequest> {
  const target = await ghTarget(userId, sessionId);
  if (!target) throw new PullRequestError("This chat has no checkout to open a pull request from.");

  const args = ["pr", "create", "--fill"];
  if (options.draft) args.push("--draft");
  const result = await runInWorkspace(userId, {
    cwd: target.dir,
    command: ["gh", ...args].map(shellQuote).join(" "),
    env: target.env,
    timeoutSeconds: CREATE_TIMEOUT_SECONDS,
  });
  if (result.exitCode !== 0) {
    throw new PullRequestError(
      result.stderr.trim() || result.stdout.trim() || "gh could not open a pull request.",
    );
  }

  // `gh pr create` prints the URL it made; the badge reads its state after.
  const url = result.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  const pullRequest = await readPullRequest(userId, sessionId);
  return (
    pullRequest ?? {
      number: 0,
      title: "",
      state: "OPEN",
      url,
      draft: options.draft,
      reviewDecision: null,
      checks: null,
    }
  );
}
