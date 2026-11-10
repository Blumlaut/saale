/**
 * The narrowest credential Saale can hand out: one chat, one repository.
 *
 * A coder chat works in a checkout of one project, whose `origin` names the
 * repository. That is the whole point of the GitHub App here — an installation
 * token limited to that repository, minted per command, so a model that tries
 * `git push` somewhere else is refused by GitHub rather than trusted not to.
 *
 * The token reaches the command three ways, all of which matter:
 *
 * - `GH_TOKEN` in the command's environment, which `gh` and its own credential
 *   helper use.
 * - The `gh` shim in the workspace leaves an existing `GH_TOKEN` alone, so a
 *   command Saale starts keeps the narrow token.
 * - The git credential helper prefers `$GH_TOKEN` when it is set, which is what
 *   makes a plain `git push` use the same narrow token instead of the workspace's
 *   wider one.
 *
 * Anything that does not resolve — no app, no project, a remote on another host,
 * a repository the installation does not cover — returns nothing, and the
 * workspace's own credential answers as before.
 */

import { loadCoderSession } from "@/lib/coder/changes";
import { remoteWebUrl } from "@/lib/coder/remote-url";
import { prisma } from "@/lib/db";
import { GithubAppError, mintGithubInstallationToken } from "./github-app";
import { readStoredGithubSource } from "./github-credentials";

/** What a coder chat may do with its repository. */
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

  if (parsed.hostname.toLowerCase() !== "github.com") return null;

  const [owner, repository] = parsed.pathname.split("/").filter(Boolean);
  if (!owner || !repository) return null;
  return { owner, repository };
}

/**
 * The environment a command in one coder chat should carry, with an installation
 * token narrowed to that chat's repository.
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

  const access = await prisma.githubInstallationAccess
    .findFirst({
      where: {
        userId,
        installation: {
          accountLogin: { equals: target.owner, mode: "insensitive" },
          suspendedAt: null,
        },
      },
      include: { installation: true },
    })
    .catch((err: unknown) => {
      console.error(`Failed to find the GitHub installation for ${target.owner}:`, err);
      return null;
    });
  if (!access) return {};

  // An installation granted "Only select repositories" is the ceiling: a chat
  // whose repository is not in it gets nothing, rather than a wider token.
  const covered = access.installation.repositories;
  if (
    access.installation.repositorySelection === "selected" &&
    Array.isArray(covered) &&
    !covered.includes(target.repository)
  ) {
    console.warn(
      `The GitHub installation for ${target.owner} does not cover ${target.repository}, so commands use the workspace credential.`,
    );
    return {};
  }

  try {
    const minted = await mintGithubInstallationToken({
      userId,
      installationId: access.installationId,
      scope: { repositories: [target.repository], permissions: CHAT_PERMISSIONS },
    });
    return { GH_TOKEN: minted.token };
  } catch (err) {
    // A refused mint is worth a log line, not a broken command: the workspace's
    // own credential still answers, just wider.
    console.error(`Failed to mint a GitHub token for ${target.owner}/${target.repository}:`, err);
    if (err instanceof GithubAppError) return {};
    return {};
  }
}
