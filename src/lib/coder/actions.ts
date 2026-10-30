/**
 * The git the panel writes.
 *
 * Every button in the worktree panel — fetch, pull, push, commit, stage,
 * discard, switch a branch — lands here. Same rule as reading: the path comes
 * from the chat's stored checkout, never from the request, and every path or
 * branch name that does reach a command is validated first.
 *
 * The whole thing runs under the repo lock, because the agent commits in the
 * same checkout and a push while a `worktree add` runs is two writers on one
 * set of objects.
 *
 * Commands that talk to a remote get the user's `GH_TOKEN` as a one-shot
 * credential helper, so a private repo pushes without the token touching the
 * workspace `.gitconfig`. A user who ran `gh auth login` has a helper of their
 * own and needs nothing here.
 */

import { checkoutOf } from "./checkout";
import { loadCoderSession } from "./changes";
import { headSha, readStatus, runGit, runInWorkspace, shellQuote, type GitResult } from "./git";
import { withLockRetry, withRepoLock } from "./lock";
import { resolveSandboxEnv } from "@/lib/sandbox/env";

/** A remote command may legitimately take minutes, and none should be cut short. */
const REMOTE_TIMEOUT_SECONDS = 120;

/** The most paths one stage or discard may name. */
export const MAX_ACTION_PATHS = 500;

/** The longest commit message the panel accepts. */
export const MAX_COMMIT_MESSAGE = 5000;

/**
 * What the panel may ask git to do.
 *
 * A path given without one of these is refused, so a new button has to be added
 * in two places on purpose.
 */
export type GitAction =
  | { action: "fetch" }
  | { action: "pull"; rebase: boolean }
  | { action: "push" }
  | { action: "commit"; message: string; amend: boolean; push: boolean }
  | { action: "stage"; paths: string[] }
  | { action: "unstage"; paths: string[] }
  | { action: "discard"; paths: string[] }
  | { action: "branch"; name: string; create: boolean }
  | { action: "stash" }
  | { action: "stash-pop" }
  | { action: "undo-commit" };

/** What a run left behind, for the toast and the refresh that follows it. */
export interface GitActionResult {
  /** Empty when the command printed nothing. */
  output: string;
}

/** The action cannot be attempted: the message is the whole answer. */
export class GitActionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitActionRefusedError";
  }
}

/** The chat has no checkout yet, so there is nothing to act on. */
export class GitActionNotReadyError extends Error {
  constructor() {
    super("The worktree is not built yet");
    this.name = "GitActionNotReadyError";
  }
}

/**
 * A credential helper that answers with `GH_TOKEN`.
 *
 * The helper form (`!`) is read as a shell snippet by git, so the token is
 * expanded when the helper runs and never appears on a command line.
 */
const GH_CREDENTIAL_HELPER =
  '!f() { echo "username=x-access-token"; echo "password=$GH_TOKEN"; }; f';

/**
 * The arguments and environment that let a network command log in.
 *
 * Without a `GH_TOKEN` nothing is added: the user's own `gh auth login` helper,
 * an ssh key or a public remote all work as they are.
 */
async function remoteAuth(
  userId: string,
): Promise<{ args: string[]; env: Record<string, string> }> {
  const env: Record<string, string> = await resolveSandboxEnv(userId).catch((err: unknown) => {
    console.error(`Failed to load sandbox variables for a git command by ${userId}:`, err);
    return {};
  });
  const token = env.GH_TOKEN;
  if (!token) return { args: [], env: {} };
  return {
    args: ["-c", `credential.helper=${GH_CREDENTIAL_HELPER}`],
    env: { GH_TOKEN: token },
  };
}

/** The trimmed message, or a refusal: an empty subject line is not a commit. */
function requireMessage(message: string): string {
  const cleaned = message.trim();
  if (!cleaned) throw new GitActionRefusedError("Write a commit message first.");
  if (cleaned.length > MAX_COMMIT_MESSAGE) {
    throw new GitActionRefusedError(
      `A commit message cannot be longer than ${MAX_COMMIT_MESSAGE} characters.`,
    );
  }
  return cleaned;
}

/**
 * A branch name git would read as a name.
 *
 * Leading dashes are refused before git sees them, since `switch` would take
 * one for a flag. `git check-ref-format` is the final word in `switchBranch`.
 */
function requireBranchName(name: string): string {
  const cleaned = name.trim();
  if (!cleaned) throw new GitActionRefusedError("Name the branch first.");
  if (cleaned.startsWith("-"))
    throw new GitActionRefusedError("A branch cannot start with a dash.");
  if (cleaned.length > 244) throw new GitActionRefusedError("That branch name is too long.");
  return cleaned;
}

/** The output a toast can quote: stdout first, stderr when git said nothing. */
function describe(result: GitResult): string {
  return (result.stdout.trim() || result.stderr.trim()).slice(0, 2000);
}

/**
 * Run one action against a chat's checkout.
 *
 * Returns null for a chat that is not the caller's. Throws
 * `GitActionNotReadyError` when the chat has no checkout yet, and git's own
 * message as a `GitError` for anything git refuses.
 */
export async function runGitAction(
  userId: string,
  sessionId: string,
  action: GitAction,
): Promise<GitActionResult | null> {
  const session = await loadCoderSession(userId, sessionId);
  if (!session) return null;
  const checkout = checkoutOf(session);
  if (!checkout) throw new GitActionNotReadyError();

  const dir = checkout.path;
  const projectId = session.projectId;
  if (!projectId) return null;

  return withRepoLock(projectId, () =>
    withLockRetry(() => performAction(userId, { dir, branch: checkout.branch }, action)),
  );
}

/** The action itself, once the checkout and the lock are known. */
async function performAction(
  userId: string,
  checkout: { dir: string; branch: string },
  action: GitAction,
): Promise<GitActionResult> {
  const dir = checkout.dir;

  switch (action.action) {
    case "fetch": {
      const auth = await remoteAuth(userId);
      const result = await runGit(userId, {
        cwd: dir,
        args: [...auth.args, "fetch", "--prune", "--all"],
        env: auth.env,
        timeoutSeconds: REMOTE_TIMEOUT_SECONDS,
      });
      return { output: describe(result) };
    }

    case "pull": {
      const status = await readStatus(userId, dir);
      if (!status.upstream) {
        throw new GitActionRefusedError(
          "This branch has no upstream. Push it first, then it can be pulled.",
        );
      }
      const auth = await remoteAuth(userId);
      const result = await runGit(userId, {
        cwd: dir,
        args: [...auth.args, "pull", ...(action.rebase ? ["--rebase"] : ["--ff-only"])],
        env: auth.env,
        timeoutSeconds: REMOTE_TIMEOUT_SECONDS,
      });
      return { output: describe(result) };
    }

    case "push": {
      const status = await readStatus(userId, dir);
      const auth = await remoteAuth(userId);
      const branch = status.branch;
      if (!branch) throw new GitActionRefusedError("A detached HEAD has no branch to push.");
      const args = status.upstream
        ? [...auth.args, "push"]
        : [...auth.args, "push", "--set-upstream", "origin", branch];
      const result = await runGit(userId, {
        cwd: dir,
        args,
        env: auth.env,
        timeoutSeconds: REMOTE_TIMEOUT_SECONDS,
      });
      return { output: describe(result) };
    }

    case "commit": {
      const message = requireMessage(action.message);
      const args = ["commit", "--message", message];
      if (action.amend) args.push("--amend");
      const committed = await runGit(userId, { cwd: dir, args });
      if (!action.push) return { output: describe(committed) };
      const pushed = await performAction(userId, checkout, { action: "push" });
      return { output: [describe(committed), pushed.output].filter(Boolean).join("\n") };
    }

    case "stage": {
      const args = action.paths.length > 0 ? ["add", "--", ...action.paths] : ["add", "--all"];
      const result = await runGit(userId, { cwd: dir, args });
      return { output: describe(result) };
    }

    case "unstage": {
      const head = await headSha(userId, dir);
      const paths = action.paths;
      // An unborn branch has no HEAD to unstage to, so the index entry itself
      // is what goes.
      const args = head
        ? ["reset", "--quiet", ...(paths.length > 0 ? ["--", ...paths] : [])]
        : [
            "rm",
            "--cached",
            "--recursive",
            "--quiet",
            "--ignore-unmatch",
            "--",
            ...(paths.length ? paths : ["."]),
          ];
      const result = await runGit(userId, { cwd: dir, args });
      return { output: describe(result) };
    }

    case "discard": {
      if (action.paths.length === 0) throw new GitActionRefusedError("Pick a file to discard.");
      const head = await headSha(userId, dir);
      if (!head) {
        throw new GitActionRefusedError(
          "This branch has no commits yet, so there is nothing to restore.",
        );
      }
      const status = await readStatus(userId, dir);
      const untracked = action.paths.filter((path) => {
        const entry = status.files.find((file) => file.path === path);
        return entry?.index === "?" || entry?.worktree === "?";
      });
      const tracked = action.paths.filter((path) => !untracked.includes(path));

      if (tracked.length > 0) {
        await runGit(userId, {
          cwd: dir,
          args: ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...tracked],
        });
      }
      if (untracked.length > 0) {
        await runGit(userId, { cwd: dir, args: ["clean", "--force", "--", ...untracked] });
      }
      return {
        output: `Discarded ${action.paths.length} file${action.paths.length === 1 ? "" : "s"}`,
      };
    }

    case "branch": {
      const name = requireBranchName(action.name);
      const checked = await runInWorkspace(userId, {
        cwd: dir,
        command: `git --no-pager check-ref-format --branch ${shellQuote(name)}`,
      });
      if (checked.exitCode !== 0) throw new GitActionRefusedError(`Not a branch name: ${name}`);
      const args = action.create ? ["switch", "--create", name] : ["switch", name];
      const result = await runGit(userId, { cwd: dir, args });
      return { output: describe(result) };
    }

    case "stash": {
      const result = await runGit(userId, {
        cwd: dir,
        args: ["stash", "push", "--include-untracked"],
        allowFailure: true,
      });
      // A clean tree is not an error to git: it exits 0 and says so.
      if (/nothing to save|no local changes/i.test(result.stdout)) {
        throw new GitActionRefusedError("Nothing to stash: the worktree is clean.");
      }
      return { output: describe(result) };
    }

    case "stash-pop": {
      const result = await runGit(userId, { cwd: dir, args: ["stash", "pop"] });
      return { output: describe(result) };
    }

    case "undo-commit": {
      const result = await runGit(userId, { cwd: dir, args: ["reset", "--soft", "HEAD~1"] });
      return { output: describe(result) };
    }

    default: {
      // Exhaustive over the union: a new action has to be handled here.
      const unreachable: never = action;
      throw new GitActionRefusedError(`Unknown action: ${JSON.stringify(unreachable)}`);
    }
  }
}
