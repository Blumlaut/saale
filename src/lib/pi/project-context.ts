/**
 * What a session inherits from the workspace it works in: the project's
 * AGENTS.md files and its skills, both in Pi's own conventions.
 *
 * Pi resolves these against a working directory. Here that directory lives
 * inside a tenant's workspace, which sits below the app's own host directories,
 * so everything Pi finds is filtered back to the workspace before it reaches a
 * prompt.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG_DIR_NAME, loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import { isNotFoundError } from "@/lib/files/errors";
import { isWithinRoot } from "@/lib/files/paths";
import { userWorkspacePath } from "@/lib/sandbox/workspace";

export interface SessionWorkspace {
  /** Absolute directory the session works in: a worktree, or the workspace root. */
  cwd: string;
  /** Absolute root of the user's workspace, which is as far as they own. */
  root: string;
}

export interface ProjectContextFile {
  path: string;
  content: string;
}

/** The workspace a session runs in, by the directory it works in. */
export function sessionWorkspace(userId: string, cwd: string): SessionWorkspace {
  return { cwd, root: userWorkspacePath(userId) };
}

/** Whether a file Pi discovered sits inside the workspace the session owns. */
export function isInWorkspace(workspace: SessionWorkspace, filePath: string): boolean {
  return isWithinRoot(workspace.root, filePath);
}

/**
 * The project instructions that apply to `cwd`, outermost directory first.
 *
 * Pi's own discovery: `AGENTS.override.md` wins over `AGENTS.md` in the same
 * directory, `CLAUDE.md` is the fallback, and a worktree whose file shadows the
 * main checkout's is loaded once.
 */
export function projectContextFiles(workspace: SessionWorkspace): ProjectContextFile[] {
  return loadProjectContextFiles({ cwd: workspace.cwd, agentDir: workspace.root }).filter((file) =>
    isInWorkspace(workspace, file.path),
  );
}

/**
 * The project's skills directory, when it has one.
 *
 * Pi loads whatever paths it is given, so the directory is named rather than
 * read here: `SKILL.md` discovery, frontmatter and the prompt section all stay
 * Pi's.
 */
export async function projectSkillPaths(workspace: SessionWorkspace): Promise<string[]> {
  const dir = path.join(workspace.cwd, CONFIG_DIR_NAME, "skills");
  const isDirectory = await fs.stat(dir).then(
    (stat) => stat.isDirectory(),
    (err: unknown) => {
      if (isNotFoundError(err)) return false;
      console.error(`Failed to check for skills in ${dir}:`, err);
      return false;
    },
  );
  return isDirectory ? [dir] : [];
}
