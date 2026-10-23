/**
 * Reconciling coder worktrees with what is on disk.
 *
 * The row and git can disagree after a crash, a manual `rm -rf`, or a container
 * restart in the middle of a checkout. The sweep fixes the bookkeeping and
 * nothing else: a directory git still tracks is never deleted, because that is
 * where someone's work is.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import { listWorktrees, pruneWorktrees } from "./git";
import { coderWorkspaceRoot, resolveCoderPath, WORKTREES_DIR } from "./paths";

/** What one sweep pass changed. */
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
 * One pass over every project.
 *
 * Not scoped to a user: this is the worker's job, and every project is checked
 * against its own row, never against another project's directory.
 */
export async function sweepWorktrees(): Promise<SweepResult> {
  const projects = await prisma.coderProject.findMany({
    select: { id: true, userId: true, slug: true, repoPath: true },
  });

  let forgotten = 0;
  const orphans: string[] = [];
  const byUser = new Map<string, typeof projects>();
  for (const project of projects) {
    byUser.set(project.userId, [...(byUser.get(project.userId) ?? []), project]);
  }

  for (const [userId, owned] of byUser) {
    // Every checkout git knows about in this workspace, so a directory it still
    // tracks is never mistaken for a stray one.
    const trackedPaths = new Set<string>();
    for (const project of owned) {
      const entries = await listWorktrees(userId, project.repoPath).catch((err: unknown) => {
        console.error(`[coder] could not list worktrees of ${project.repoPath}:`, err);
        return [];
      });
      for (const entry of entries) {
        trackedPaths.add(resolveCoderPath(userId, entry.relative ?? entry.path));
      }
      await pruneWorktrees(userId, project.repoPath);
    }

    const rows = await prisma.coderWorktree.findMany({
      where: { projectId: { in: owned.map((project) => project.id) } },
      select: { sessionId: true, path: true, status: true },
    });

    for (const row of rows) {
      if (row.status !== "active") continue;
      if (await directoryExists(resolveCoderPath(userId, row.path))) continue;
      await prisma.coderWorktree.update({
        where: { sessionId: row.sessionId },
        data: { status: "removed", removedAt: new Date() },
      });
      forgotten += 1;
    }

    const claimed = new Set(rows.map((row) => row.path));
    const found = await listWorktreeDirs(userId, coderWorkspaceRoot(userId));
    for (const project of owned) {
      for (const dir of found) {
        if (!dir.startsWith(`${project.slug}/`)) continue;
        const relative = `${WORKTREES_DIR}/${dir}`;
        if (claimed.has(relative)) continue;
        const absolute = resolveCoderPath(userId, relative);
        if (trackedPaths.has(absolute)) continue;
        orphans.push(absolute);
      }
    }
  }

  if (orphans.length > 0) {
    console.warn(`[coder] directories no worktree row claims: ${orphans.join(", ")}`);
  }

  return { forgotten, orphans };
}
