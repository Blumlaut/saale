/**
 * Reconciling coder worktrees with what is on disk.
 *
 * The row and git can disagree after a crash, a manual `rm -rf`, or a container
 * restart in the middle of a checkout. The pass fixes the bookkeeping and
 * nothing else: a directory git still tracks is never deleted, because that is
 * where someone's work is.
 *
 * It covers one user at a time, and it runs from the chat that is about to use
 * git anyway. Asking git about every project would start the container of every
 * user who has one, none of whom is there.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import { listWorktrees, pruneWorktrees } from "./git";
import { withRepoLock } from "./lock";
import {
  coderWorkspaceRoot,
  resolveCoderPath,
  WORKTREES_DIR,
  workspaceDirectoryExists,
} from "./paths";

/** What one pass changed. */
export interface SweepResult {
  /** Rows whose checkout is gone, so they were marked removed. */
  forgotten: number;
  /** Directories under `worktrees/` that no row claims. logged, never removed. */
  orphans: string[];
}

async function directoryExists(absolute: string): Promise<boolean> {
  return fs
    .stat(absolute)
    .then((stat) => stat.isDirectory())
    .catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    });
}

/** Directories under one worktree root, relative to the workspace. */
async function listWorktreeDirs(userId: string, root: string): Promise<string[]> {
  const found: string[] = [];
  let projects: string[];
  try {
    projects = await fs.readdir(path.join(root, WORKTREES_DIR));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return found;
    throw err;
  }

  for (const project of projects) {
    const projectDir = path.join(root, WORKTREES_DIR, project);
    const entries = await fs.readdir(projectDir).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    });
    for (const entry of entries) found.push(`${project}/${entry}`);
  }

  return found;
}

/**
 * One user's projects, checked against their rows.
 *
 * `exceptSessionId` names the chat whose row the caller answers for: it is
 * about to build the checkout this pass would report as gone.
 */
export async function sweepUserWorktrees(
  userId: string,
  options: { exceptSessionId?: string } = {},
): Promise<SweepResult> {
  const projects = await prisma.coderProject.findMany({
    where: { userId },
    select: { id: true, slug: true, repoPath: true },
  });

  let forgotten = 0;
  const orphans: string[] = [];
  if (projects.length === 0) return { forgotten, orphans };

  // Every checkout git knows about in this workspace, so a directory it still
  // tracks is never mistaken for a stray one.
  const trackedPaths = new Set<string>();
  for (const project of projects) {
    // A repo directory deleted by hand has no worktrees git can name, and
    // asking leaves a failure in the log on every pass.
    if (!(await workspaceDirectoryExists(userId, project.repoPath))) continue;
    const entries = await withRepoLock(project.id, async () => {
      const listed = await listWorktrees(userId, project.repoPath).catch((err: unknown) => {
        console.error(`[coder] could not list worktrees of ${project.repoPath}:`, err);
        return [];
      });
      await pruneWorktrees(userId, project.repoPath);
      return listed;
    });
    for (const entry of entries) {
      trackedPaths.add(resolveCoderPath(userId, entry.relative ?? entry.path));
    }
  }

  const rows = await prisma.coderWorktree.findMany({
    where: { projectId: { in: projects.map((project) => project.id) } },
    select: { sessionId: true, path: true, status: true },
  });

  for (const row of rows) {
    if (row.status !== "active") continue;
    if (row.sessionId === options.exceptSessionId) continue;
    if (await directoryExists(resolveCoderPath(userId, row.path))) continue;
    await prisma.coderWorktree.update({
      where: { sessionId: row.sessionId },
      data: { status: "removed", removedAt: new Date() },
    });
    forgotten += 1;
  }

  const claimed = new Set(rows.map((row) => row.path));
  const found = await listWorktreeDirs(userId, coderWorkspaceRoot(userId));
  for (const project of projects) {
    for (const dir of found) {
      if (!dir.startsWith(`${project.slug}/`)) continue;
      const relative = `${WORKTREES_DIR}/${dir}`;
      if (claimed.has(relative)) continue;
      const absolute = resolveCoderPath(userId, relative);
      if (trackedPaths.has(absolute)) continue;
      orphans.push(absolute);
    }
  }

  if (orphans.length > 0) {
    console.warn(`[coder] directories no worktree row claims: ${orphans.join(", ")}`);
  }

  return { forgotten, orphans };
}

/** How long a user's worktrees stay reconciled before the next chat looks again. */
const SWEEP_TTL_MS = 10 * 60_000;

/** When each user was last reconciled. */
const lastSwept = new Map<string, number>();

/**
 * Reconcile a user's worktrees from the chat that is provisioning.
 *
 * The container is up by now, so this wakes nothing, and a burst of chats in
 * one project asks git once. A failure is logged by the caller: the chat's own
 * checkout is worked out either way.
 */
export async function sweepUserWorktreesOnUse(userId: string, sessionId: string): Promise<void> {
  const at = Date.now();
  if (at - (lastSwept.get(userId) ?? 0) < SWEEP_TTL_MS) return;
  lastSwept.set(userId, at);
  await sweepUserWorktrees(userId, { exceptSessionId: sessionId });
}
