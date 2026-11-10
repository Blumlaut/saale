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
import { signOutGithub } from "@/lib/coder/github";
import { ensureUserSettings } from "@/lib/settings/update";
import { GithubAppError, readGithubUserAccess } from "./github-app";
import { GITHUB_SOURCE_NONE, isGithubSourceValue, type GithubSource } from "./github-source";

/** The one host this connection is about. An enterprise instance is not it. */
export const GITHUB_HOST_URL = "https://github.com";

/** The helper script, relative to the workspace root (`$HOME` in the container). */
export const GITHUB_HELPER_FILE = ".local/bin/saale-git-credential";

/** Where the app's helper finds the token for a repository owner. */
export const GITHUB_CREDENTIAL_FILE = ".saale/github.json";

/**
 * The source this account stored, as the settings row says.
 *
 * Read here rather than through the settings registry so the caller cannot
 * confuse a stale value with a missing one: anything unrecognised means "not
 * linked", which is the safe default.
 */
export async function readStoredGithubSource(userId: string): Promise<GithubSource | ""> {
  const settings = await ensureUserSettings(userId).catch((err: unknown) => {
    console.error(`Failed to read the GitHub source of ${userId}:`, err);
    return null;
  });
  const stored = settings?.githubSource ?? GITHUB_SOURCE_NONE;
  return isGithubSourceValue(stored) ? stored : GITHUB_SOURCE_NONE;
}

/** Sign the workspace's GitHub CLI out, so nothing answers beside our helper. */
async function signOutGithubCli(userId: string): Promise<void> {
  const status = await signOutGithub(userId).catch((err: unknown) => {
    console.error(`Failed to sign the GitHub CLI out of the workspace of ${userId}:`, err);
    return null;
  });
  if (status?.error) {
    console.error(`The GitHub CLI sign-out for ${userId} reported: ${status.error}`);
  }
}

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

// ─── The helper script ──────────────────────────────────────────────────────

/**
 * The script git calls for github.com while the app is the source.
 *
 * It answers git's credential protocol (`get`, `store`, `erase`) from the token
 * file, and — crucially — falls back to `gh auth git-credential` when there is no
 * token. A stale token therefore degrades to the CLI login instead of failing a
 * push outright.
 *
 * A `gh` shim in the same directory is not needed for that: `gh` reads `GH_TOKEN`
 * from the command's environment, which `runInWorkspace` sets from the same file
 * (see `github-command-env.ts`).
 */
const HELPER_SCRIPT = `#!/bin/sh
# Written by Saale. Answers git's credential request for github.com from the
# token file, and delegates to the GitHub CLI when there is no token.
case "$1" in
  get)
    body=$(cat)
    token=$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "\${CREDENTIAL_FILE}" 2>/dev/null)
    if [ -n "$token" ]; then
      echo "username=x-access-token"
      echo "password=$token"
      exit 0
    fi
    printf '%s\\n' "$body" | exec /usr/bin/gh auth git-credential "$@"
    ;;
  store|erase)
    exec /usr/bin/gh auth git-credential "$@"
    ;;
esac
exit 0
`;

/** Where the app's token is written, absolute (the helper needs it inlined). */
function credentialPath(userId: string): string {
  return path.join(coderWorkspaceRoot(userId), GITHUB_CREDENTIAL_FILE);
}

/** The helper script, as it is written into one workspace. */
export function githubHelperScript(userId: string): string {
  return HELPER_SCRIPT.replace("\${CREDENTIAL_FILE}", credentialPath(userId));
}

/** Write the helper and mark it executable, whoever owns the workspace. */
async function installHelperScript(userId: string): Promise<void> {
  const absolute = await writeWorkspaceFile(
    userId,
    GITHUB_HELPER_FILE,
    Buffer.from(githubHelperScript(userId), "utf8"),
  );
  await fs.chmod(absolute, 0o755).catch((err: unknown) => {
    console.error(`Failed to make the GitHub credential helper executable (${absolute}):`, err);
  });
}

/** Store the token the helper reads. Nothing else is written there. */
async function writeCredential(userId: string, token: string): Promise<void> {
  await writeWorkspaceFile(
    userId,
    GITHUB_CREDENTIAL_FILE,
    Buffer.from(`${JSON.stringify({ token })}\n`, "utf8"),
  );
}

/** Take the token away; the helper then falls back to the CLI. */
async function removeCredential(userId: string): Promise<void> {
  await fs.rm(credentialPath(userId), { force: true }).catch((err: unknown) => {
    console.error(`Failed to remove the GitHub credential file for ${userId}:`, err);
  });
}

/** Whether a token file is there, without reading it into a log or a prompt. */
export async function hasGithubCredential(userId: string): Promise<boolean> {
  try {
    await fs.access(credentialPath(userId));
    return true;
  } catch {
    return false;
  }
}

// ─── Applying the source ────────────────────────────────────────────────────

/**
 * Give the workspace the credential of the active source, and no other.
 *
 * `app`: the helper and a token file, and `gh` is signed out of the workspace so
 * its own token cannot answer a command beside ours.
 * `cli` or nothing: our helper and file go away, and gh's own login — untouched
 * by Saale — is what commands use.
 */
export async function applyGithubSource(userId: string, source: GithubSource | ""): Promise<void> {
  if (source !== "app") {
    await applyGithubHelper(userId, source);
    await removeCredential(userId);
    return;
  }

  const access = await readGithubUserAccess(userId);
  if (!access) {
    throw new GithubAppError(
      "Connect GitHub again: the app's authorization has expired, so the workspace cannot be given a token.",
    );
  }

  await installHelperScript(userId);
  await writeCredential(userId, access.accessToken);
  await applyGithubHelper(userId, "app");
  await signOutGithubCli(userId);
}

/**
 * Refresh the token file before a command that talks to a remote.
 *
 * The user token lasts eight hours and is refreshed on use, so the file has to
 * be rewritten whenever it is older than the token it holds. Idempotent: a file
 * that already carries the current token is left alone.
 */
export async function ensureGithubCredential(userId: string): Promise<void> {
  const source = await readStoredGithubSource(userId);
  if (source !== "app") return;

  const access = await readGithubUserAccess(userId);
  if (!access) {
    console.error(`The GitHub app token of ${userId} is gone, so the workspace keeps its old one.`);
    return;
  }

  const absolute = credentialPath(userId);
  const existing = await fs.readFile(absolute, "utf8").catch(() => null);
  const wanted = `${JSON.stringify({ token: access.accessToken })}\n`;
  if (existing === wanted) return;

  await writeCredential(userId, access.accessToken);
}

/**
 * The variables a command that talks to GitHub should carry.
 *
 * While the app is the source this is the app's token, refreshed first, so `gh`
 * and a `git` invocation that goes through `gh` reach GitHub as the account.
 * Otherwise the object is empty and the caller keeps whatever it read from the
 * workspace's own variables — the CLI source and its `GH_TOKEN` stay untouched.
 */
export async function resolveGithubCommandEnv(userId: string): Promise<Record<string, string>> {
  const source = await readStoredGithubSource(userId);
  if (source !== "app") return {};

  const access = await readGithubUserAccess(userId);
  if (!access) {
    console.error(`The GitHub app token of ${userId} is gone, so commands fall back to the CLI.`);
    return {};
  }

  // The helper git runs for a push reads the same token from the file, so keep
  // the two in step here rather than on a schedule of their own.
  const absolute = credentialPath(userId);
  const wanted = `${JSON.stringify({ token: access.accessToken })}\n`;
  const existing = await fs.readFile(absolute, "utf8").catch(() => null);
  if (existing !== wanted) await writeCredential(userId, access.accessToken);

  return { GH_TOKEN: access.accessToken };
}
