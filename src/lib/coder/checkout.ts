/**
 * The directory a coder chat runs in.
 *
 * A project either gives every chat a worktree of its own, or runs them all in
 * the project's own checkout. Only the first case has a `CoderWorktree` row, so
 * everything that reads a chat's checkout asks here instead of that row.
 */

import { prisma } from "@/lib/db";

/** How a project hands chats their checkout. */
export const CHAT_MODES = ["worktree", "repo"] as const;

export type ChatMode = (typeof CHAT_MODES)[number];

/** A project from before the column existed gives every chat a worktree. */
export function normalizeChatMode(value: unknown): ChatMode {
  return value === "repo" ? "repo" : "worktree";
}

/** The checkout a chat works in. */
export interface ChatCheckout {
  /** Workspace-relative, e.g. `worktrees/saale/c-1a2b3c4d` or `projects/saale`. */
  path: string;
  /** The branch git has it on, "" until a status read says. */
  branch: string;
  /** The commit a worktree branched from; "" for the project's checkout. */
  baseSha: string;
  mode: ChatMode;
}

/** The rows a checkout is decided from. */
export interface CheckoutSource {
  project: { repoPath: string; chatMode: string } | null;
  coderWorktree: { path: string; branch: string; baseSha: string; status: string } | null;
}

/**
 * The checkout a chat runs in, or null when it has none yet.
 *
 * A worktree row wins over the project's mode: a project switched to the shared
 * checkout while a chat had one keeps that chat's worktree as it is.
 */
export function checkoutOf(source: CheckoutSource): ChatCheckout | null {
  const worktree = source.coderWorktree;
  if (worktree && worktree.status === "active") {
    return {
      path: worktree.path,
      branch: worktree.branch,
      baseSha: worktree.baseSha,
      mode: "worktree",
    };
  }
  if (source.project && normalizeChatMode(source.project.chatMode) === "repo") {
    return { path: source.project.repoPath, branch: "", baseSha: "", mode: "repo" };
  }
  return null;
}

/** The chat's checkout, scoped to its owner. Null when it has none yet. */
export async function loadChatCheckout(
  userId: string,
  sessionId: string,
): Promise<ChatCheckout | null> {
  const chat = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId, projectId: { not: null } },
    select: {
      project: { select: { repoPath: true, chatMode: true } },
      coderWorktree: { select: { path: true, branch: true, baseSha: true, status: true } },
    },
  });
  return chat ? checkoutOf(chat) : null;
}
