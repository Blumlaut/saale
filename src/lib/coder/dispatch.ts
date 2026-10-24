/**
 * A watcher fire that goes into a project.
 *
 * The fire gets a coder chat of its own: a row here, then the ordinary chat run
 * (`respondInChat`), which is what builds the worktree through `ensureChatAgent`.
 * There is no second way to construct an agent, so a bot chat is held to the
 * same approval gate, the same worktree rules and the same isolation as a chat a
 * person started.
 *
 * `per-fire` gives every fire its own chat and worktree, so two fires never
 * share a directory and a bot never touches a checkout someone is working in.
 * `sticky` reuses one chat for a thread that runs across fires.
 */

import { prisma } from "@/lib/db";
import { respondInChat } from "@/lib/chat/respond-in-chat";
import { createChatSessionRow, sanitizeChatTitle } from "@/lib/chat/create-session";
import { coderChatSlug, toCoderSlug, watcherBranchName } from "@/lib/coder/slug";
import { splitModelReference } from "@/lib/pi/model-ref";
import { isWorktreeMode, type WorktreeMode } from "@/lib/watchers/delivery";

/** Longest piece of the fire's own value that goes into a title. */
const TITLE_SUMMARY_LENGTH = 30;

/** Branch key a sticky watcher's single checkout sits on. */
const STICKY_KEY = "sticky";

/** What a watcher needs for a fire to land in a project. */
export interface DispatchTarget {
  userId: string;
  watcher: {
    id: string;
    name: string;
    projectId: string | null;
    worktreeMode: string;
    stickySessionId: string | null;
  };
  /** Model for a chat the fire opens, as `provider:modelId`. */
  modelId: string | null;
  /** What the agent is handed: the wake message. */
  message: string;
  /** The script's return value, for the chat's title. */
  value: unknown;
}

/**
 * A chat title from what fired.
 *
 * A list of chats all called "PR bot" says nothing about which pull request each
 * one is about, so the value is read into the title.
 */
export function fireTitle(options: { name: string; value: unknown }): string {
  let summary: string;
  try {
    const text = typeof options.value === "string" ? options.value : JSON.stringify(options.value);
    summary = (text ?? "")
      .replace(/["{}[\]]/g, " ")
      .replace(/\s*([,:])\s*/g, "$1 ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, TITLE_SUMMARY_LENGTH)
      .replace(/[\s,:]+$/, "")
      .trim();
  } catch (err) {
    console.error("Failed to read a watcher value for a chat title:", err);
    summary = "";
  }
  return sanitizeChatTitle(summary ? `${options.name}: ${summary}` : options.name);
}

/**
 * The branch a fire's worktree is checked out on.
 *
 * The key is the fire's own chat id for `per-fire`, so two fires cannot ask for
 * one branch, and `sticky` for the one checkout a watcher keeps.
 */
export function fireBranch(options: {
  watcherName: string;
  sessionId: string;
  mode: WorktreeMode;
}): string {
  const watcherSlug = toCoderSlug(options.watcherName).slice(0, 40).replace(/-+$/, "");
  const key = options.mode === "sticky" ? STICKY_KEY : coderChatSlug(options.sessionId);
  return watcherBranchName(watcherSlug || "watcher", key);
}

/**
 * The chat a sticky watcher keeps, if it is still there and still in the project.
 *
 * A chat deleted by hand leaves the id behind; a new one is made rather than
 * failing the fire.
 */
async function findStickyChat(options: {
  userId: string;
  projectId: string;
  sessionId: string | null;
}): Promise<string | null> {
  if (!options.sessionId) return null;

  const chat = await prisma.chatSession.findFirst({
    where: { id: options.sessionId, userId: options.userId, projectId: options.projectId },
    select: { id: true },
  });
  return chat?.id ?? null;
}

/**
 * Dispatch a fire into its project and run the turn there.
 *
 * Resolves when the run has settled. The chat and its worktree outlive it: a
 * `per-fire` chat is removed later only when its branch is pushed and its tree
 * is clean (`retention.ts`), and a sticky one stays until someone deletes it.
 */
export async function dispatchWatcherRun(options: DispatchTarget): Promise<{ sessionId: string }> {
  const { watcher, userId } = options;

  if (!watcher.projectId) {
    throw new Error("This watcher has no project to dispatch into.");
  }

  const project = await prisma.coderProject.findFirst({
    where: { id: watcher.projectId, userId },
    select: { id: true },
  });
  if (!project) {
    throw new Error("This watcher's project is gone.");
  }

  const mode: WorktreeMode = isWorktreeMode(watcher.worktreeMode)
    ? watcher.worktreeMode
    : "per-fire";

  let sessionId =
    mode === "sticky"
      ? await findStickyChat({ userId, projectId: project.id, sessionId: watcher.stickySessionId })
      : null;

  if (!sessionId) {
    const id = crypto.randomUUID();
    const model = splitModelReference(options.modelId);
    const created = await createChatSessionRow(userId, {
      id,
      projectId: project.id,
      ...(model ? { modelProvider: model.provider, modelName: model.name } : {}),
      title: fireTitle({ name: watcher.name, value: options.value }),
      origin: "watcher",
      originId: watcher.id,
      worktreeBranch: fireBranch({ watcherName: watcher.name, sessionId: id, mode }),
    });
    sessionId = created.id;

    if (mode === "sticky") {
      await prisma.scriptWatcher.update({
        where: { id: watcher.id },
        data: { stickySessionId: sessionId },
      });
    }
  }

  // The ordinary chat run: it builds the worktree (the chat is a coder chat, so
  // `ensureChatAgent` does) and persists the turn like any other.
  await respondInChat({ userId, sessionId, message: options.message });

  return { sessionId };
}
