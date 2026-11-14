/**
 * The credential a coder chat's commands carry: the installation, at chat
 * permissions.
 *
 * A chat works in a checkout of one project, but a change rarely stays in one
 * repository: a branch goes to a fork while the pull request targets the
 * upstream it was forked from, and the second repository is read on the way. So
 * the chat gets the installation's token — every repository GitHub approved for
 * this account — rather than one for the project's repository alone.
 *
 * The installation is still the ceiling, and now the only one: a push to a
 * repository GitHub did not approve for this app is refused by GitHub, not by a
 * promise in Saale.
 *
 * The token reaches the command three ways, all of which matter:
 *
 * - `GH_TOKEN` in the command's environment, which `gh` and its own credential
 *   helper use.
 * - The `gh` shim in the workspace leaves an existing `GH_TOKEN` alone, so a
 *   command Saale starts keeps the chat's token.
 * - The git credential helper prefers `$GH_TOKEN` when it is set, which is what
 *   makes a plain `git push` use the same token instead of the workspace's own.
 *
 * Anything that does not resolve — no app, no project, a remote on another host,
 * no installation for the owner — returns nothing, and the workspace's own
 * credential answers as before.
 */

import { loadCoderSession } from "@/lib/coder/changes";
import { remoteWebUrl } from "@/lib/coder/remote-url";
import { GITHUB_HOST } from "./github";
import { githubInstallationForOwner, mintGithubInstallationToken } from "./github-app";
import { readStoredGithubSource } from "./github-credentials";

/** What a coder chat may do on the repositories the installation covers. */
const CHAT_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  workflows: "write",
  checks: "read",
} as const;

/** The owner and repository a remote names, or null for anything else. */
export function repositoryFromRemote(remoteUrl: string | null): {
  owner: string;
  repository: string;
} | null {
  if (!remoteUrl) return null;

  const web = remoteWebUrl(remoteUrl);
  if (!web) return null;

  let parsed: URL;
  try {
    parsed = new URL(web);
  } catch (err) {
    console.error(`Failed to read the repository out of "${remoteUrl}":`, err);
    return null;
  }

  if (parsed.hostname.toLowerCase() !== GITHUB_HOST) return null;

  const [owner, repository] = parsed.pathname.split("/").filter(Boolean);
  if (!owner || !repository) return null;
  return { owner, repository };
}

/**
 * What an uncovered repository means for a command: no credential at all.
 *
 * Setting `GH_TOKEN` is not the only way the workspace answers — the `git`
 * credential helper and the `gh` shim read a token file that holds the account's
 * own, wide token. Leaving `GH_TOKEN` out would therefore fall back to *more*
 * access than the chat is allowed, so both readers are switched off for this
 * command: the helper list is reset and git is told not to ask, and the shim
 * exits on `SAALE_NO_GITHUB_CREDENTIAL`. A push then fails with "could not read
 * Username" and `gh` says why, instead of quietly widening.
 */
const NO_CREDENTIAL_ENV: Record<string, string> = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "credential.helper",
  GIT_CONFIG_VALUE_0: "",
  GIT_TERMINAL_PROMPT: "0",
  // The other reader of the same token file: the `gh` shim on the sandbox PATH.
  SAALE_NO_GITHUB_CREDENTIAL: "1",
};

/**
 * The environment a command in one coder chat should carry: the installation's
 * token, at the chat's permissions.
 */
export async function resolveGithubSessionEnv(
  userId: string,
  sessionId: string,
): Promise<Record<string, string>> {
  const source = await readStoredGithubSource(userId);
  if (source !== "app") return {};

  const session = await loadCoderSession(userId, sessionId).catch((err: unknown) => {
    console.error(`Failed to load the coder session ${sessionId} for its GitHub token:`, err);
    return null;
  });
  const target = repositoryFromRemote(session?.project?.originUrl ?? null);
  if (!target) return {};

  const installation = await githubInstallationForOwner(userId, target.owner);
  if (!installation) {
    console.warn(
      `No GitHub installation of ${userId} covers ${target.owner}, so commands carry no GitHub credential.`,
    );
    return { ...NO_CREDENTIAL_ENV };
  }

  // A repository the installation does not cover is not in the token either, so
  // the chat still gets a working credential for the rest of the installation:
  // the warning is what explains the refusal GitHub answers on this one.
  const covered = installation.repositories;
  if (
    installation.repositorySelection === "selected" &&
    covered &&
    !covered.includes(target.repository)
  ) {
    console.warn(
      `The GitHub installation for ${target.owner} does not cover ${target.repository}. Commands carry the installation's token, which reaches the rest of it.`,
    );
  }

  try {
    const minted = await mintGithubInstallationToken({
      userId,
      installationId: installation.rowId,
      scope: { permissions: CHAT_PERMISSIONS },
    });
    return { GH_TOKEN: minted.token };
  } catch (err) {
    // A refused mint is worth a log line and nothing else: the covered case has
    // no credential to fall back to, so the command runs without one.
    console.error(`Failed to mint a GitHub token for ${target.owner}/${target.repository}:`, err);
    return { ...NO_CREDENTIAL_ENV };
  }
}
