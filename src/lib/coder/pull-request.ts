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
import { prisma } from "@/lib/db";
import {
  resolveGithubCommandEnv,
  resolveGithubUserEnv,
} from "@/lib/integrations/github-credentials";
import { resolveSandboxEnv } from "@/lib/sandbox/env";

/** A question about a branch: short, and the panel can ask again later. */
const VIEW_TIMEOUT_SECONDS = 30;

/** Opening a pull request talks to the forge for longer. */
const CREATE_TIMEOUT_SECONDS = 60;

/** A cached state older than this is worth another question to the forge. */
const PR_REFRESH_MS = 5 * 60_000;

/** How many rows one list read refreshes, so a big board stays one round trip. */
const MAX_PR_REFRESHES = 3;

/** A pull request in one of these states cannot move again. */
const TERMINAL_PR_STATES = new Set(["MERGED", "CLOSED"]);

/** Chats a refresh is already running for, so overlapping reads do not double up. */
const refreshing = new Set<string>();

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
): Promise<{ dir: string; env: Record<string, string>; ownEnv: Record<string, string> } | null> {
  const session = await loadCoderSession(userId, sessionId);
  if (!session) return null;
  const checkout = checkoutOf(session);
  if (!checkout) return null;

  const ownEnv: Record<string, string> = await resolveSandboxEnv(userId).catch((err: unknown) => {
    console.error(`Failed to load sandbox variables for gh in ${checkout.path}:`, err);
    return {};
  });
  const commandEnv: Record<string, string> = await resolveGithubCommandEnv(userId).catch(
    (err: unknown) => {
      console.error(`Failed to resolve the GitHub credential for gh in ${checkout.path}:`, err);
      return {};
    },
  );
  const token = commandEnv.GH_TOKEN ?? ownEnv.GH_TOKEN;
  return {
    dir: checkout.path,
    env: token ? { GH_TOKEN: token } : {},
    // Who the account is, before Saale's own credential replaced its variable.
    ownEnv,
  };
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
  const read = await readPullRequestState(userId, sessionId);
  return read.pullRequest;
}

/**
 * A read of the forge, and whether it answered about the branch at all.
 *
 * `known: false` is a missing checkout, a missing token or a forge the command
 * could not reach. It is what keeps a cached state from being cleared by a
 * question nobody answered.
 */
async function readPullRequestState(
  userId: string,
  sessionId: string,
): Promise<{ pullRequest: CoderPullRequest | null; known: boolean }> {
  const target = await ghTarget(userId, sessionId);
  if (!target) return { pullRequest: null, known: false };

  const result = await runInWorkspace(userId, {
    cwd: target.dir,
    command: "gh pr view --json number,title,state,url,isDraft,reviewDecision,statusCheckRollup",
    env: target.env,
    timeoutSeconds: VIEW_TIMEOUT_SECONDS,
  });
  if (result.exitCode !== 0) {
    const message = result.stderr.trim();
    // gh says "no pull requests found" here, which is an answer, not a failure.
    if (/no pull requests found/i.test(message)) return { pullRequest: null, known: true };
    if (!/not a git repository|no remotes/i.test(message)) {
      console.warn(`[coder] gh could not read the pull request for ${target.dir}: ${message}`);
    }
    return { pullRequest: null, known: false };
  }

  return { pullRequest: parsePullRequest(result.stdout), known: true };
}

/**
 * What the forge last said about the chat's branch, kept on the chat row.
 *
 * The landing page draws a badge for every chat it lists, and a `gh` round trip
 * per row is not something a list that polls can afford, so the answer is
 * written down here and refreshed in the background.
 */
async function savePullRequest(
  userId: string,
  sessionId: string,
  read: { pullRequest: CoderPullRequest | null; known: boolean },
): Promise<void> {
  try {
    await prisma.chatSession.updateMany({
      where: { id: sessionId, userId },
      // A question nobody answered still counts as asked, so the list does not
      // go on asking it on every poll.
      data: read.known
        ? {
            prNumber: read.pullRequest?.number ?? null,
            prState: read.pullRequest?.state ?? null,
            prDraft: read.pullRequest?.draft ?? null,
            prUrl: read.pullRequest?.url ?? null,
            prCheckedAt: new Date(),
          }
        : { prCheckedAt: new Date() },
    });
  } catch (err) {
    console.error(`Failed to cache the pull request of chat ${sessionId}:`, err);
  }
}

/** Ask the forge about the branch and write down what it said. */
export async function syncPullRequest(
  userId: string,
  sessionId: string,
): Promise<CoderPullRequest | null> {
  const read = await readPullRequestState(userId, sessionId);
  await savePullRequest(userId, sessionId, read);
  return read.pullRequest;
}

/** A chat row as far as a pull request refresh is concerned. */
export interface PullRequestCacheRow {
  id: string;
  pullRequest: { state: string } | null;
  /** When `gh` last answered, with a pull request or without one. */
  pullRequestCheckedAt: Date | null;
}

/**
 * Re-ask the forge about the pull requests a list is about to show stale.
 *
 * A merged pull request only says so once somebody asks again, and the row that
 * carries it is the one the user reads. The list route calls this without
 * waiting for it: the response carries what is cached, and the next poll of the
 * list carries the answer.
 */
export async function refreshStalePullRequests(
  userId: string,
  chats: readonly PullRequestCacheRow[],
): Promise<void> {
  const now = Date.now();
  const stale = chats
    .filter((chat) => {
      if (refreshing.has(chat.id)) return false;
      // A chat nobody asked about gets one question, so a badge appears for a
      // pull request opened outside the app without every row costing a call.
      if (!chat.pullRequestCheckedAt) return true;
      // Asked, and the branch had none: nothing to keep asking about.
      if (!chat.pullRequest) return false;
      if (TERMINAL_PR_STATES.has(chat.pullRequest.state)) return false;
      return now - chat.pullRequestCheckedAt.getTime() > PR_REFRESH_MS;
    })
    .slice(0, MAX_PR_REFRESHES);

  await Promise.all(
    stale.map(async (chat) => {
      refreshing.add(chat.id);
      try {
        await syncPullRequest(userId, chat.id);
      } catch (err) {
        console.error(`Failed to refresh the pull request of chat ${chat.id}:`, err);
      } finally {
        refreshing.delete(chat.id);
      }
    }),
  );
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

  // The author GitHub records is the token's. An installation token names the
  // app's bot, so this one call uses the person's own authorization: the chat
  // pushed the branch under the narrow token, and opening the pull request is
  // the moment the work has to belong to somebody.
  const authorEnv = await resolveGithubUserEnv(userId, target.ownEnv).catch((err: unknown) => {
    console.error(`Failed to resolve the GitHub author for ${target.dir}:`, err);
    return {};
  });

  const args = ["pr", "create", "--fill"];
  if (options.draft) args.push("--draft");
  const result = await runInWorkspace(userId, {
    cwd: target.dir,
    command: ["gh", ...args].map(shellQuote).join(" "),
    env: { ...target.env, ...authorEnv },
    timeoutSeconds: CREATE_TIMEOUT_SECONDS,
  });
  if (result.exitCode !== 0) {
    throw new PullRequestError(
      result.stderr.trim() || result.stdout.trim() || "gh could not open a pull request.",
    );
  }

  // `gh pr create` prints the URL it made; the badge reads its state after.
  const url = result.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  const pullRequest = await syncPullRequest(userId, sessionId);
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
