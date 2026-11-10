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
import { ensureGitconfig, gitIdentityFor, withCredentialHelper } from "@/lib/coder/gitconfig";
import { prisma } from "@/lib/db";
import { isNotFoundError } from "@/lib/files/errors";
import { writeWorkspaceFile } from "@/lib/sandbox/workspace";
import { signOutGithub } from "@/lib/coder/github";
import { ensureAdminSettings, ensureUserSettings } from "@/lib/settings/update";
import { GithubAppError, readGithubUserAccess } from "./github-app";
import {
  GITHUB_SOURCE_NONE,
  GITHUB_TOKEN_PRECEDENCE_DEFAULT,
  isGithubSourceValue,
  isGithubTokenPrecedence,
  type GithubSource,
  type GithubTokenPrecedence,
} from "./github-source";

/** The one host this connection is about. An enterprise instance is not it. */
export const GITHUB_HOST_URL = "https://github.com";

/** The helper script, relative to the workspace root (`$HOME` in the container). */
export const GITHUB_HELPER_FILE = ".local/bin/saale-git-credential";

/** Where the app's helper finds the token for a repository owner. */
export const GITHUB_CREDENTIAL_FILE = ".saale/github.json";

/**
 * A `gh` that talks as the app, earlier on the PATH than the real one.
 *
 * The app's token reaches Saale's own commands through the environment, but an
 * agent that types `gh pr create` itself gets no such environment — and in app
 * mode its gh login is gone. This shim closes that: it exports the token and
 * hands over to the binary in `/usr/bin`, so `gh` behaves the same whether Saale
 * called it or the model did.
 */
export const GITHUB_GH_SHIM_FILE = ".local/bin/gh";

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

/**
 * What an instance does when the app is the source *and* the account keeps its
 * own `GH_TOKEN` in the sandbox variables.
 *
 * One credential is always used, never both; this is only about which.
 */
export async function readGithubTokenPrecedence(): Promise<GithubTokenPrecedence> {
  const admin = await ensureAdminSettings().catch((err: unknown) => {
    console.error("Failed to read the GitHub token precedence of this instance:", err);
    return null;
  });
  const stored = admin?.githubTokenPrecedence ?? GITHUB_TOKEN_PRECEDENCE_DEFAULT;
  return isGithubTokenPrecedence(stored) ? stored : GITHUB_TOKEN_PRECEDENCE_DEFAULT;
}

/** What a command may carry, and what has to be taken away from it. */
export interface GithubCredentialPolicy {
  /** Whether the app's token may be put into a command's environment. */
  injectAppToken: boolean;
  /** Whether a `GH_TOKEN` the account set is removed from that environment. */
  stripUserToken: boolean;
}

/**
 * The one credential a command carries, from the source and the instance's
 * precedence rule.
 *
 * Pure, because this is the whole "never two credentials" guarantee: while the
 * app is the source, `app` precedence delivers the app's token and drops the
 * account's own variable, and `variable` precedence delivers nothing and leaves
 * that variable alone. With any other source this module has no opinion.
 */
export function credentialPolicyFor(
  source: GithubSource | "",
  precedence: GithubTokenPrecedence,
): GithubCredentialPolicy {
  if (source !== "app") return { injectAppToken: false, stripUserToken: false };
  return precedence === "variable"
    ? { injectAppToken: false, stripUserToken: false }
    : { injectAppToken: true, stripUserToken: true };
}

/** The same decision, read from the database. */
export async function githubCredentialPolicy(userId: string): Promise<GithubCredentialPolicy> {
  const [source, precedence] = await Promise.all([
    readStoredGithubSource(userId),
    readGithubTokenPrecedence(),
  ]);
  return credentialPolicyFor(source, precedence);
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
 * Commands Saale starts carry `GH_TOKEN` (see `resolveGithubCommandEnv`), but a
 * command the agent types in a terminal has only what the shell has, which is
 * why `installGhShim` puts a `gh` in front of the real one: the shim reads the
 * same token file when nothing narrower is set.
 */
const HELPER_SCRIPT = `#!/bin/sh
# Written by Saale. Answers git's credential request for github.com from the
# token file, and delegates to the GitHub CLI when there is no token.
case "$1" in
  get)
    body=$(cat)
    # A token in the environment is the narrowest one there is: a chat's
    # installation token, minted for that chat's repository.
    if [ -n "$GH_TOKEN" ]; then
      echo "username=x-access-token"
      echo "password=$GH_TOKEN"
      exit 0
    fi
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

const GH_SHIM_SCRIPT = `#!/bin/sh
# Written by Saale. Runs the real gh with the app's token while the app is the
# source, so a command typed by the agent and one run by Saale behave the same.
if [ -z "$GH_TOKEN" ]; then # a chat's narrowed token wins
  token=$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "\${CREDENTIAL_FILE}" 2>/dev/null)
  if [ -n "$token" ]; then
    GH_TOKEN="$token"
    export GH_TOKEN
  fi
fi
exec /usr/bin/gh "$@"
`;

/** Where the app's token is written, absolute (the helper needs it inlined). */
function credentialPath(userId: string): string {
  return path.join(coderWorkspaceRoot(userId), GITHUB_CREDENTIAL_FILE);
}

/** The `gh` shim, as it is written into one workspace. */
export function githubGhShimScript(userId: string): string {
  return GH_SHIM_SCRIPT.replace("${CREDENTIAL_FILE}", credentialPath(userId));
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

/** Write the shim that runs the real `gh` with the app's token. */
async function installGhShim(userId: string): Promise<void> {
  const absolute = await writeWorkspaceFile(
    userId,
    GITHUB_GH_SHIM_FILE,
    Buffer.from(githubGhShimScript(userId), "utf8"),
  );
  await fs.chmod(absolute, 0o755).catch((err: unknown) => {
    console.error(`Failed to make the gh shim executable (${absolute}):`, err);
  });
}

/** Take the shim away, so the real gh runs as the CLI login again. */
async function removeGhShim(userId: string): Promise<void> {
  await fs
    .rm(path.join(coderWorkspaceRoot(userId), GITHUB_GH_SHIM_FILE), { force: true })
    .catch((err: unknown) => {
      console.error(`Failed to remove the gh shim for ${userId}:`, err);
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
    await removeGhShim(userId);
    await applyGitIdentity(userId, null);
    return;
  }

  const access = await readGithubUserAccess(userId);
  if (!access) {
    throw new GithubAppError(
      "Connect GitHub again: the app's authorization has expired, so the workspace cannot be given a token.",
    );
  }

  await installHelperScript(userId);
  await installGhShim(userId);
  await writeCredential(userId, access.accessToken);
  await applyGithubHelper(userId, "app");
  await signOutGithubCli(userId);
  await applyGitIdentity(userId, { login: access.login });
}

/**
 * Point the commit identity at whoever pushes.
 *
 * With the app in place the pusher is the app, so a plain commit reads as the
 * bot's work; the connected account and its `users.noreply.github.com` address
 * are what GitHub links back to the person. Without the app the identity is the
 * account's own, and an installation that was removed goes back to it.
 */
async function applyGitIdentity(userId: string, author: { login: string } | null): Promise<void> {
  const user = await prisma.user
    .findUnique({
      where: { id: userId },
      select: { name: true, username: true, email: true },
    })
    .catch((err: unknown) => {
      console.error(`Failed to read the account of ${userId} for its commit identity:`, err);
      return null;
    });
  if (!user) return;

  await ensureGitconfig(userId, gitIdentityFor(user, author)).catch((err: unknown) => {
    console.error(`Failed to write the commit identity of ${userId}:`, err);
  });
}

/**
 * The token the connected person acts with, for the calls that are attributed.
 *
 * An installation token is the app, so a pull request it opens is authored by
 * the app's bot. Opening one is a single call whose author is read, so it uses
 * the person's own authorization instead — which also carries only what that
 * person may reach. Writes that a chat runs keep the narrowed installation
 * token; this is not a replacement for it.
 *
 * `ownEnv` is the account's own sandbox variables, because
 * `admin.githubTokenPrecedence = "variable"` promises that a `GH_TOKEN` kept
 * there wins over the app. Without one there, the app is the only credential
 * left, so this still answers and the pull request keeps its author.
 */
export async function resolveGithubUserEnv(
  userId: string,
  ownEnv: Record<string, string> = {},
): Promise<Record<string, string>> {
  const [source, policy] = await Promise.all([
    readStoredGithubSource(userId),
    githubCredentialPolicy(userId),
  ]);
  if (source !== "app") return {};
  if (!policy.injectAppToken && ownEnv.GH_TOKEN) return {};

  const access = await readGithubUserAccess(userId).catch((err: unknown) => {
    console.error(`Failed to read the GitHub authorization of ${userId} for a command:`, err);
    return null;
  });
  return access ? { GH_TOKEN: access.accessToken } : {};
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
  const policy = await githubCredentialPolicy(userId);
  if (!policy.injectAppToken) return {};

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
