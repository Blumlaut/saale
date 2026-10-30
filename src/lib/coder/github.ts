/**
 * GitHub sign-in for a workspace, through the `gh` binary.
 *
 * `gh auth login` is all of it: GitHub's device flow runs against the client id
 * the CLI ships with, so no OAuth app has to be registered and no token has to
 * be pasted anywhere. The token lands in `~/.config/gh` on the workspace
 * volume, which is the `HOME` every chat and worktree shares, and gh points git
 * at the same token.
 *
 * The status read asks gh rather than looking for a file, so a login made in
 * the workspace terminal, a `GH_TOKEN` among the user's variables and a token
 * GitHub has since revoked all read the way a command would find them.
 */

import {
  GITHUB_DEVICE_URL,
  findDeviceCode,
  parseGithubHosts,
  type GithubProbe,
  type GithubStatus,
} from "@/lib/integrations/github";
import { exec as sandboxExec, kill as killExec } from "@/lib/sandbox/client";
import { resolveSandboxEnvVar } from "@/lib/sandbox/env";
import { userIdentity } from "@/lib/sandbox/identity";
import { ensureWorkspace } from "@/lib/sandbox/workspace";
import { runInWorkspace, type GitResult } from "./git";
import { resolveCoderPath } from "./paths";

/** gh prints the code within a second; a request waits this long before giving up on it. */
const CODE_WAIT_MS = 15_000;

/** How often the wait above looks at the attempt. */
const CODE_POLL_MS = 150;

/** GitHub expires a device code after fifteen minutes. */
const LOGIN_TIMEOUT_SECONDS = 900;

/** Status reads and logouts answer immediately unless the network is in the way. */
const COMMAND_TIMEOUT_SECONDS = 30;

/** Output kept from a sign-in, so a failure has something to quote. */
const MAX_OUTPUT_CHARS = 4000;

const GITHUB_HOST = "github.com";

/** The variable that outranks a gh login, and the one Saale hands commands. */
const TOKEN_VARIABLE = "GH_TOKEN";

/** Both flags keep gh from prompting: without them it asks for host and protocol. */
const LOGIN_COMMAND = `gh auth login --hostname ${GITHUB_HOST} --git-protocol https`;

/** A sign-in gh is holding open for a user to approve. */
interface LoginAttempt {
  /** The code, once gh has printed it. */
  code: string | null;
  /** The running command, while there is one. */
  execId: string | null;
  /** Why it stopped, when it stopped without signing in. */
  error: string | null;
  finished: boolean;
}

/** Attempts by user, this process's only state: the token is gh's to keep. */
const attempts = new Map<string, LoginAttempt>();

/**
 * The credential gh finds in this user's workspace, and any sign-in still
 * waiting on a browser.
 */
export async function githubStatus(userId: string): Promise<GithubStatus> {
  const probe = await probeGithub(userId);
  const attempt = attempts.get(userId);

  // A sign-in that ended well needs nothing more from the card: the credential
  // is the answer from here on.
  if (attempt?.finished && !attempt.error) attempts.delete(userId);

  const running = attempt && !attempt.finished ? attempt : null;
  return {
    credential: probe.credential,
    pending: running ? { code: running.code, url: GITHUB_DEVICE_URL } : null,
    error: running ? probe.error : (attempt?.error ?? probe.error),
  };
}

/**
 * Start a sign-in and return the code, once gh has printed it.
 *
 * The command outlives this call: it keeps polling GitHub until the user
 * approves or the code expires, and a status read afterwards reports the
 * credential. Starting again while one waits returns the same code.
 */
export async function startGithubLogin(userId: string): Promise<GithubStatus> {
  const current = attempts.get(userId);
  const attempt = current && !current.finished ? current : launchLogin(userId);

  const deadline = Date.now() + CODE_WAIT_MS;
  while (!attempt.code && !attempt.error && !attempt.finished && Date.now() < deadline) {
    await sleep(CODE_POLL_MS);
  }

  return githubStatus(userId);
}

/**
 * Forget a sign-in in flight.
 *
 * The command is killed with it: a code left polling would sign the user in
 * after they closed the dialog.
 */
export async function cancelGithubLogin(userId: string): Promise<void> {
  const attempt = attempts.get(userId);
  attempts.delete(userId);
  if (!attempt?.execId) return;

  try {
    await killExec(attempt.execId);
  } catch (err) {
    console.error(`Failed to stop the GitHub sign-in for ${userId}:`, err);
  }
}

/**
 * Sign out, and stop a sign-in in flight first.
 *
 * gh removes the token from its config here. A token the user keeps in a
 * variable is theirs: the card says so and points at the variables list rather
 * than editing it.
 */
export async function signOutGithub(userId: string): Promise<GithubStatus> {
  await cancelGithubLogin(userId);

  // Cancelling a sign-in that never finished reaches here too, and there is
  // nothing for gh to log out of.
  const before = await probeGithub(userId);
  if (!before.credential && !before.error) {
    return { credential: null, pending: null, error: null };
  }

  const result = await runInWorkspace(userId, {
    cwd: ".",
    command: `gh auth logout --hostname ${GITHUB_HOST}`,
    timeoutSeconds: COMMAND_TIMEOUT_SECONDS,
  });

  const status = await githubStatus(userId);
  if (result.exitCode === 0) return status;
  return { ...status, error: failureLine(result) ?? "Could not sign out of GitHub" };
}

/**
 * Ask gh what it would answer with.
 *
 * The user's `GH_TOKEN` goes to the command, because that variable wins over a
 * gh login: a workspace signed in through the card but carrying a stale token
 * has to read as signed out, which is what an agent's command would hit.
 */
async function probeGithub(userId: string): Promise<GithubProbe> {
  await ensureWorkspace(userIdentity(userId));
  const token = await resolveSandboxEnvVar(userId, TOKEN_VARIABLE);

  const result = await runInWorkspace(userId, {
    cwd: ".",
    command: "gh auth status --json hosts",
    env: token ? { [TOKEN_VARIABLE]: token } : {},
    timeoutSeconds: COMMAND_TIMEOUT_SECONDS,
  });
  return parseGithubHosts(result.stdout);
}

/** Run the login in the background, filling in an attempt as gh answers. */
function launchLogin(userId: string): LoginAttempt {
  const attempt: LoginAttempt = { code: null, execId: null, error: null, finished: false };
  attempts.set(userId, attempt);

  void (async () => {
    let output = "";
    let exitCode: number | null = null;

    try {
      await ensureWorkspace(userIdentity(userId));
      for await (const event of sandboxExec({
        identity: userIdentity(userId),
        command: LOGIN_COMMAND,
        cwd: resolveCoderPath(userId, "."),
        timeoutSeconds: LOGIN_TIMEOUT_SECONDS,
      })) {
        if (event.type === "started") {
          attempt.execId = event.execId;
        } else if (event.type === "chunk") {
          output = `${output}${event.data.toString("utf8")}`.slice(-MAX_OUTPUT_CHARS);
          attempt.code ??= findDeviceCode(output);
        } else if (event.type === "exit") {
          exitCode = event.timedOut ? null : event.exitCode;
        }
      }
    } catch (err) {
      console.error(`Failed to run the GitHub sign-in for ${userId}:`, err);
      attempt.error = "The GitHub sign-in could not run in your workspace";
    } finally {
      attempt.execId = null;
      attempt.finished = true;
      if (exitCode === 0) {
        await pointGitAtGh(userId);
      } else if (!attempt.error) {
        attempt.error =
          withoutCodes(lastLine(output)) ?? "The GitHub sign-in ended before it was approved";
      }
    }
  })();

  return attempt;
}

/**
 * Point git at gh's credential helper.
 *
 * gh does this itself at the end of a login; the explicit call keeps the
 * guarantee here rather than in the CLI's own defaults.
 */
async function pointGitAtGh(userId: string): Promise<void> {
  try {
    const result = await runInWorkspace(userId, {
      cwd: ".",
      command: `gh auth setup-git --hostname ${GITHUB_HOST}`,
      timeoutSeconds: COMMAND_TIMEOUT_SECONDS,
    });
    if (result.exitCode !== 0) {
      console.error(`gh auth setup-git failed for ${userId}: ${failureLine(result) ?? ""}`);
    }
  } catch (err) {
    console.error(`Failed to run gh auth setup-git for ${userId}:`, err);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The last non-empty line of a command's output. */
function lastLine(output: string): string | null {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? null;
}

/** gh's stderr without the escape codes it colours its notices with. */
function withoutCodes(line: string | null): string | null {
  if (!line) return null;

  const plain = line.replace(/\u001b\[[0-9;]*m/g, "").replace(/^[!x✓*]\s*/, "");
  return plain || null;
}

/** What a failed command said, preferring its stderr. */
function failureLine(result: GitResult): string | null {
  return withoutCodes(lastLine(result.stderr.trim() || result.stdout.trim()));
}
