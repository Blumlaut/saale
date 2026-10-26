/**
 * Creating a chat session row. shared by `POST /api/chat/sessions` and the
 * `chat_create` tool, so a chat started by an agent has the same shape as one
 * started from the UI (sanitized title, generated id, explicit fields).
 *
 * Model, thinking level and tool config are optional: a caller that has none
 * leaves them null/undefined and the chat resolves the user's defaults when it
 * first runs (`resolveChatModel` / `DEFAULT_TOOL_CONFIG`).
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resolveCoderToolConfig } from "@/lib/pi/coder-tools";

/** Longest title the UI renders; longer titles are truncated everywhere. */
const MAX_TITLE_LENGTH = 50;

/** The title an unnamed chat carries, and what a caller that has none sends. */
export const DEFAULT_CHAT_TITLE = "New Chat";

export interface NewChatSessionInput {
  /** Defaults to a random id. A caller that names the branch needs it up front. */
  id?: string | undefined;
  title?: string | null | undefined;
  temporary?: boolean | undefined;
  modelProvider?: string | null | undefined;
  modelName?: string | null | undefined;
  /** A normalized Pi thinking level (`normalizeThinkingLevelSetting`). */
  thinkingLevel?: string | null | undefined;
  /** Raw tool category config; stored as given, resolved when the chat runs. */
  toolConfig?: unknown;
  /** Set for a coder chat: the project its worktree is built from. */
  projectId?: string | null | undefined;
  /** "user", or "watcher" for a chat a watcher fire opened. */
  origin?: string | undefined;
  /** The watcher that opened it. */
  originId?: string | null | undefined;
  /** Branch its worktree is checked out on; null derives one from the id. */
  worktreeBranch?: string | null | undefined;
}

export interface NewChatSession {
  id: string;
  title: string;
  createdAt: Date;
}

/** Strip null bytes and cap the length. titles are rendered raw. */
export function sanitizeChatTitle(title: string | null | undefined): string {
  return (title || DEFAULT_CHAT_TITLE).replace(/\0/g, "").slice(0, MAX_TITLE_LENGTH);
}

/**
 * The tool config a new coder chat starts with.
 *
 * Resolved at creation rather than at run time, so the chat keeps the set it
 * was started with when the user changes their coder defaults later.
 */
async function coderToolConfigFor(userId: string): Promise<Record<string, boolean>> {
  const settings = await prisma.appSettings.findUnique({
    where: { userId },
    select: { coderToolConfig: true },
  });
  return resolveCoderToolConfig(settings?.coderToolConfig as Record<string, unknown> | null);
}

export async function createChatSessionRow(
  userId: string,
  input: NewChatSessionInput = {},
): Promise<NewChatSession> {
  const toolConfig =
    input.toolConfig !== undefined
      ? input.toolConfig
      : input.projectId
        ? await coderToolConfigFor(userId)
        : undefined;

  const title = sanitizeChatTitle(input.title);

  const chatSession = await prisma.chatSession.create({
    data: {
      id: input.id ?? crypto.randomUUID(),
      userId,
      title,
      // The placeholder is what a caller with no title sends, so it does not name the chat
      titleSource: title === DEFAULT_CHAT_TITLE ? "default" : "user",
      temporary: input.temporary ?? false,
      modelProvider: input.modelProvider ?? null,
      modelName: input.modelName ?? null,
      ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.originId ? { originId: input.originId } : {}),
      ...(input.worktreeBranch ? { worktreeBranch: input.worktreeBranch } : {}),
      ...(toolConfig === undefined ? {} : { toolConfig: toolConfig as Prisma.InputJsonValue }),
    },
  });

  return { id: chatSession.id, title: chatSession.title, createdAt: chatSession.createdAt };
}
