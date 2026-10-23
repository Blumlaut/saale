/**
 * The one migration the workspaces volume needs, run by the processes that use
 * it rather than by an operator.
 *
 * A user's directory used to be `user-<userId>`: 30+ characters that every path
 * an agent read or typed inside it repeated. It is now `user-<key>`, a short
 * digest of the id (see `./identity`), which leaves the old directory behind. A
 * deploy that skipped that rename would hand every user an empty workspace, so
 * no deploy step exists: each process moves what it finds before it answers
 * anything.
 *
 * No database is involved. The old name carries the id and the new key is
 * derived from it, which is why this can run in a worker or the sandbox service
 * as readily as in the web app.
 *
 * Running it twice, or from three processes at once, is safe: a directory
 * already named by a key is left alone, `fs.rename` is atomic, and a rename that
 * loses the race fails with ENOENT, which means the other process did it.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { isNotFoundError } from "@/lib/files/errors";
import { deriveUserWorkspaceKey, USER_WORKSPACE_KEY_LENGTH } from "./identity";
import { workspacesDir } from "./workspace";

/** One directory that moved, or would have moved. */
export interface LegacyRename {
  from: string;
  to: string;
}

export interface IdentityMigration {
  renamed: LegacyRename[];
  /** Both names exist: two directories for one user, left for a human. */
  conflicts: LegacyRename[];
  /** A `user-` directory this cannot name a target for. */
  unrecognised: string[];
}

/**
 * Shortest suffix treated as a legacy user id.
 *
 * Every id this app issued is 25 (cuid) or 32 (better-auth) characters. A
 * shorter one is not an id, so the directory is reported instead of guessed at.
 */
const MIN_LEGACY_ID_LENGTH = 20;

/** A directory that already carries a key: hex only, exactly key length. */
const KEYED_DIR_PATTERN = new RegExp(`^user-[0-9a-f]{${USER_WORKSPACE_KEY_LENGTH}}$`);

/** A name this can derive a target for: `user-` and an id, nothing else. */
const LEGACY_DIR_PATTERN = /^user-([A-Za-z0-9_-]+)$/;

/**
 * The name a legacy workspace directory should have, or null when there is
 * nothing to do.
 *
 * A keyed directory is never renamed: the key is a hash, so the id it came from
 * cannot be recovered to confirm anything about it.
 */
export function legacyTargetName(name: string): string | null {
  if (KEYED_DIR_PATTERN.test(name)) return null;
  const match = LEGACY_DIR_PATTERN.exec(name);
  const id = match?.[1];
  if (!id || id.length < MIN_LEGACY_ID_LENGTH) return null;
  return `user-${deriveUserWorkspaceKey(id)}`;
}

/**
 * Move every legacy directory under `dir` (the volume by default), then point
 * the absolute paths inside it at the name it now has.
 *
 * `fs.rename` keeps the inode, so permissions, ownership and contents come
 * along; nothing is copied and nothing is deleted.
 */
export async function migrateLegacyIdentities(
  options: { dir?: string } = {},
): Promise<IdentityMigration> {
  const dir = options.dir ?? workspacesDir();
  const report: IdentityMigration = { renamed: [], conflicts: [], unrecognised: [] };

  let entries;
  try {
    entries = await fs.readdir(/*turbopackIgnore: true*/ dir, { withFileTypes: true });
  } catch (err) {
    if (isNotFoundError(err)) return report;
    throw err;
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const target = legacyTargetName(entry.name);
    if (!target) {
      if (entry.name.startsWith("user-") && !KEYED_DIR_PATTERN.test(entry.name)) {
        report.unrecognised.push(entry.name);
      } else if (KEYED_DIR_PATTERN.test(entry.name)) {
        // A directory an earlier boot already moved can still hold stale paths
        // if that boot stopped halfway: repairing is idempotent and cheap.
        await repairWorkspacePaths(
          entry.name,
          path.join(/*turbopackIgnore: true*/ dir, entry.name),
        );
      }
      continue;
    }

    // The volume is a runtime path: nothing here is part of the build.
    const to = path.join(/*turbopackIgnore: true*/ dir, target);
    const taken = await fs.stat(/*turbopackIgnore: true*/ to).then(
      () => true,
      (err: unknown) => {
        if (isNotFoundError(err)) return false;
        throw err;
      },
    );
    if (taken) {
      report.conflicts.push({ from: entry.name, to: target });
      continue;
    }

    try {
      await fs.rename(path.join(/*turbopackIgnore: true*/ dir, entry.name), to);
      report.renamed.push({ from: entry.name, to: target });
    } catch (err) {
      // Another process moved it between the check and the rename: the outcome
      // is the one wanted either way.
      if (isNotFoundError(err)) continue;
      throw err;
    }

    await repairWorkspacePaths(target, to);
  }

  return report;
}

/**
 * The absolute paths a workspace has written into its own files, pointed at
 * wherever it lives now.
 *
 * A moved directory is not self-contained: git records the worktree and the
 * repository it belongs to by absolute path, in two files per checkout, and the
 * app's `.gitconfig` allows the workspace by absolute path too. Left alone, the
 * old names make every existing checkout report `fatal: not a git repository`.
 *
 * The rewrite is by identity, not by remembering what moved: a path naming
 * `…/user-<id>` belongs to this workspace exactly when the id derives to this
 * workspace's key. That makes it idempotent and safe to run on a directory
 * nobody renamed.
 */
export async function repairWorkspacePaths(identity: string, root: string): Promise<string[]> {
  const rewritten: string[] = [];

  for (const file of await filesWithAbsolutePaths(root)) {
    let text: string;
    try {
      text = await fs.readFile(/*turbopackIgnore: true*/ file, "utf8");
    } catch (err) {
      if (isNotFoundError(err)) continue;
      throw err;
    }

    const updated = rewriteWorkspacePaths(text, identity, root);
    if (updated === text) continue;

    await fs.writeFile(/*turbopackIgnore: true*/ file, updated, "utf8");
    rewritten.push(file);
  }

  return rewritten;
}

/**
 * `text` with every path that names this workspace pointed at `root`.
 *
 * Only whole absolute paths are considered, so prose and relative paths are
 * untouched, and a path naming another user's workspace is left exactly as it
 * is: that is the isolation the identity check exists for.
 */
export function rewriteWorkspacePaths(text: string, identity: string, root: string): string {
  return text.replace(ABSOLUTE_PATH_PATTERN, (match) => {
    const segments = match.split("/");
    const at = segments.findIndex((segment) => /^user-[A-Za-z0-9_-]+$/.test(segment));
    if (at < 0) return match;
    const name = segments[at];
    if (!name || userIdentityFromName(name) !== identity) return match;

    const rest = segments.slice(at + 1).join("/");
    return rest ? `${root}/${rest}` : root;
  });
}

/** The identity a directory name derives to, or null when it is not one. */
function userIdentityFromName(name: string): string | null {
  const id = name.slice("user-".length);
  if (!id) return null;
  return `user-${deriveUserWorkspaceKey(id)}`;
}

/** Every path this module treats as a whole absolute path in a file. */
const ABSOLUTE_PATH_PATTERN = /\/[^\s"'=:;]*/g;

/** Largest file worth reading: git metadata and `.gitconfig` are bytes. */
const MAX_REPAIR_FILE_BYTES = 64 * 1024;

/**
 * The files a workspace keeps absolute paths in.
 *
 * Both sides of every git worktree link, plus the config that allows the
 * workspace as a git directory. Nothing else in a workspace is written by the
 * app with its own path.
 */
async function filesWithAbsolutePaths(root: string): Promise<string[]> {
  const files: string[] = [path.join(root, ".gitconfig")];

  for (const project of await subdirectories(path.join(root, "worktrees"))) {
    for (const checkout of await subdirectories(path.join(root, "worktrees", project))) {
      files.push(path.join(root, "worktrees", project, checkout, ".git"));
    }
  }

  for (const project of await subdirectories(path.join(root, "projects"))) {
    for (const checkout of await subdirectories(
      path.join(root, "projects", project, ".git", "worktrees"),
    )) {
      files.push(path.join(root, "projects", project, ".git", "worktrees", checkout, "gitdir"));
    }
  }

  const present: string[] = [];
  for (const file of files) {
    const size = await fs
      .stat(/*turbopackIgnore: true*/ file)
      .then((stats) => (stats.isFile() ? stats.size : null))
      .catch((err: unknown) => {
        if (isNotFoundError(err)) return null;
        throw err;
      });
    if (size !== null && size <= MAX_REPAIR_FILE_BYTES) present.push(file);
  }
  return present;
}

/** Directory names under `dir`, or none when it is not there. */
async function subdirectories(dir: string): Promise<string[]> {
  const entries = await fs
    .readdir(/*turbopackIgnore: true*/ dir, { withFileTypes: true })
    .catch((err: unknown) => {
      if (isNotFoundError(err)) return [];
      throw err;
    });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/**
 * Run the migration at startup and report it, without ever blocking the caller.
 *
 * Startup is the only moment this is safe to assume: a process that answers a
 * request or takes a job before it ran would create the new directory next to
 * the old one and split a user's files. Nothing here can repair that, so a
 * failure is loud and leaves the old directories untouched.
 */
export async function migrateWorkspaceIdentitiesOnBoot(source: string): Promise<void> {
  try {
    const report = await migrateLegacyIdentities();

    if (report.renamed.length > 0) {
      console.warn(
        `[${source}] moved ${report.renamed.length} workspace director` +
          `${report.renamed.length === 1 ? "y" : "ies"} to the short identity scheme`,
      );
    }
    for (const conflict of report.conflicts) {
      console.error(
        `[${source}] both ${conflict.from} and ${conflict.to} exist: merge them by hand, ` +
          "neither directory was touched",
      );
    }
    for (const name of report.unrecognised) {
      console.error(`[${source}] left ${name} alone: its suffix is not a user id`);
    }
  } catch (err) {
    console.error(`[${source}] workspace identity migration failed, nothing was moved:`, err);
  }
}
