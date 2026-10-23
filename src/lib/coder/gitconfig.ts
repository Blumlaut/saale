/**
 * The workspace's git identity.
 *
 * `$HOME` inside the sandbox container is the workspace root, so one
 * `.gitconfig` there applies to every repo and worktree the user has. It is
 * written before the first project: a commit without an identity fails, and a
 * coding agent that hits that has to spend a turn discovering it.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { writeOwned } from "@/lib/sandbox/workspace";
import { GITCONFIG_FILE, coderWorkspaceRoot } from "./paths";

export interface GitIdentity {
  name: string;
  email: string;
}

/** Trim, and fall back rather than write an empty setting. */
function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/[\r\n\0]/g, " ").trim();
}

/**
 * The commit identity for a user.
 *
 * Their account name and email: a commit made on their behalf should be theirs,
 * and Saale has no second identity to offer.
 */
export function gitIdentityFor(user: {
  name?: string | null;
  username?: string | null;
  email: string;
}): GitIdentity {
  const email = clean(user.email) || "saale@localhost";
  const name = clean(user.name) || clean(user.username) || email.split("@")[0] || "saale";
  return { name, email };
}

/**
 * The `.gitconfig` body.
 *
 * `safe.directory` because the volume is written from two accounts (the app
 * creates directories, the container's user writes in them), and git refuses a
 * repo it considers to belong to someone else. `pull.ff = only` because an
 * agent that pulls into a merge commit has made a decision nobody asked for.
 */
export function gitconfigBody(identity: GitIdentity, workspacePath: string): string {
  return [
    "# written by saale",
    "[user]",
    `\tname = ${identity.name}`,
    `\temail = ${identity.email}`,
    "[init]",
    "\tdefaultBranch = main",
    "[pull]",
    "\tff = only",
    "[safe]",
    `\tdirectory = ${workspacePath}`,
    "[core]",
    "\tpager = cat",
    "",
  ].join("\n");
}

/**
 * Write the workspace `.gitconfig` when it is missing or stale.
 *
 * Returns the absolute path. A config that already matches is left alone, so
 * this is cheap enough to call before every project operation.
 */
export async function ensureGitconfig(userId: string, identity: GitIdentity): Promise<string> {
  const root = coderWorkspaceRoot(userId);
  const target = path.join(root, GITCONFIG_FILE);
  const body = gitconfigBody(identity, root);

  const existing = await fs.readFile(target, "utf8").catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  });
  if (existing === body) return target;

  await writeOwned(target, Buffer.from(body, "utf8"));
  return target;
}
