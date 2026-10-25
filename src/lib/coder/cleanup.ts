/**
 * Removing a project.
 *
 * The repo directory is kept unless git proves nothing is left behind (a clean
 * tree with every commit pushed) or the user confirmed the delete after being
 * told what it throws away. A refusal arrives with that confirmation, so the
 * button never quietly discards work and never gets stuck either.
 */

import { prisma } from "@/lib/db";
import { deleteChatSession } from "@/lib/chat/delete-session";
import { getActiveSessions } from "@/lib/redis";
import { WORKTREE_KEPT_CODE } from "./force-delete";
import { GitError, isRepoFullyPushed, runInWorkspace, shellQuote } from "./git";
import { workspaceDirectoryExists } from "./paths";
import { CoderCleanupError, removeChatWorktree } from "./worktree-removal";

/**
 * Remove a project: its worktrees, its chats, then the repo.
 *
 * The repo is checked first, because that refusal names the most work and costs
 * nothing to answer. Each worktree is removed through git next, so a dirty one
 * refuses on its own. The chats go only after every checkout is gone.
 */
export async function removeProject(
  userId: string,
  projectId: string,
  force: boolean = false,
): Promise<void> {
  const project = await prisma.coderProject.findFirst({
    where: { id: projectId, userId },
    select: { id: true, repoPath: true, name: true, chats: { select: { id: true } } },
  });
  if (!project) throw new CoderCleanupError("Project not found", 404);

  const generating = await getActiveSessions(userId);
  const busy = project.chats.filter((chat) => generating.has(chat.id));
  if (busy.length > 0) {
    throw new CoderCleanupError("A chat in this project is generating. Stop it first.");
  }

  // A repo directory deleted by hand leaves no git to ask and no work to lose,
  // so the row is all that is left of the project.
  const repoExists = await workspaceDirectoryExists(userId, project.repoPath);
  if (repoExists && !force) {
    const pushed = await isRepoFullyPushed(userId, project.repoPath).catch((err: unknown) => {
      if (err instanceof GitError) return false;
      throw err;
    });
    if (!pushed) {
      throw new CoderCleanupError(
        "The project has uncommitted changes or commits that are not pushed. Commit and push them first.",
        409,
        WORKTREE_KEPT_CODE,
      );
    }
  }

  // Worktrees next: a dirty one refuses, and then the chats are still there.
  for (const chat of project.chats) {
    await removeChatWorktree(userId, chat.id, force);
  }

  for (const chat of project.chats) {
    await deleteChatSession(userId, chat.id);
  }

  const result = await runInWorkspace(userId, {
    cwd: ".",
    command: `rm -rf -- ${shellQuote(project.repoPath)}`,
  });
  if (result.exitCode !== 0) {
    console.error(`Failed to remove the repo directory ${project.repoPath}:`, result.stderr);
    throw new CoderCleanupError("Could not remove the repo directory");
  }

  await prisma.coderProject.deleteMany({ where: { id: projectId, userId } });
}
