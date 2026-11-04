/**
 * What "one source at a time" means on disk.
 *
 * Two sources exist — the GitHub CLI's own login and this instance's GitHub App
 * (see `github-source.ts`) — and a workspace carries exactly one of them. What
 * that comes to in the workspace is this module:
 *
 * - `~/.gitconfig` holds one credential helper for `github.com`: the app's when
 *   the app is the source, and none when the CLI owns the credential, because
 *   `gh auth setup-git` writes its own. `withCredentialHelper()` enforces the
 *   "one" part by removing every entry in that subsection first.
 * - The app's helper reads its token from a file on the volume, which is written
 *   when a token is minted and removed with the source. The CLI's token stays
 *   where gh keeps it, in `~/.config/gh`.
 *
 * The helper script itself lives in `~/.local/bin` on the volume rather than only
 * in the sandbox image: a container created before this feature existed has the
 * old image and would never find a script that only shipped in a new one.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { GITCONFIG_FILE, coderWorkspaceRoot } from "@/lib/coder/paths";
import { withCredentialHelper } from "@/lib/coder/gitconfig";
import { isNotFoundError } from "@/lib/files/errors";
import { writeWorkspaceFile } from "@/lib/sandbox/workspace";
import type { GithubSource } from "./github-source";

/** The one host this connection is about. An enterprise instance is not it. */
export const GITHUB_HOST_URL = "https://github.com";

/** The helper script, relative to the workspace root (`$HOME` in the container). */
export const GITHUB_HELPER_FILE = ".local/bin/saale-git-credential";

/** Where the app's helper finds the token for a repository owner. */
export const GITHUB_CREDENTIAL_FILE = ".saale/github.json";

/** The helper as git config wants it: the `!` makes git run it through a shell. */
export function githubHelperCommand(userId: string): string {
  return `!${path.join(coderWorkspaceRoot(userId), GITHUB_HELPER_FILE)}`;
}

/**
 * Give the workspace the helper of the active source, and no other.
 *
 * Idempotent, and cheap enough to call before every remote command: an entry
 * that is already the only one and matches leaves the file untouched. A `.gitconfig`
 * that does not exist yet is created with just this subsection — the commit
 * identity is `ensureGitconfig`'s job, not this one's.
 */
export async function applyGithubHelper(userId: string, source: GithubSource | ""): Promise<void> {
  const target = path.join(coderWorkspaceRoot(userId), GITCONFIG_FILE);

  const existing = await fs.readFile(target, "utf8").catch((err: unknown) => {
    if (isNotFoundError(err)) return "";
    throw err;
  });

  const command = source === "app" ? githubHelperCommand(userId) : null;
  const body = withCredentialHelper(existing, GITHUB_HOST_URL, command);
  if (body === existing) return;

  await writeWorkspaceFile(userId, GITCONFIG_FILE, Buffer.from(body, "utf8"));
}
