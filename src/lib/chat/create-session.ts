/**
 * Creating a chat session row — shared by `POST /api/chat/sessions` and the
 * `chat_create` tool, so a chat started by an agent has the same shape as one
 * started from the UI (sanitized title, generated id, explicit fields).
 *
 * Model, thinking level and tool config are optional: a caller that has none
 * leaves them null/undefined and the chat resolves the user's defaults when it
 * first runs (`resolveChatModel` / `DEFAULT_TOOL_CONFIG`).
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

/** Longest title the UI renders; longer titles are truncated everywhere. */
const MAX_TITLE_LENGTH = 50;

export interface NewChatSessionInput {
  title?: string | null | undefined;
  temporary?: boolean | undefined;
  modelProvider?: string | null | undefined;
  modelName?: string | null | undefined;
  /** A normalized Pi thinking level (`normalizeThinkingLevelSetting`). */
  thinkingLevel?: string | null | undefined;
  /** Raw tool category config; stored as given, resolved when the chat runs. */
  toolConfig?: unknown;
}

export interface NewChatSession {
  id: string;
  title: string;
  createdAt: Date;
}

/** Strip null bytes and cap the length — titles are rendered raw. */
export function sanitizeChatTitle(title: string | null | undefined): string {
  return (title || "New Chat").replace(/\0/g, "").slice(0, MAX_TITLE_LENGTH);
}

export async function createChatSessionRow(
  userId: string,
  input: NewChatSessionInput = {},
): Promise<NewChatSession> {
  const chatSession = await prisma.chatSession.create({
    data: {
      id: crypto.randomUUID(),
      userId,
      title: sanitizeChatTitle(input.title),
      temporary: input.temporary ?? false,
      modelProvider: input.modelProvider ?? null,
      modelName: input.modelName ?? null,
      ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
      ...(input.toolConfig === undefined
        ? {}
        : { toolConfig: input.toolConfig as Prisma.InputJsonValue }),
    },
  });

  return { id: chatSession.id, title: chatSession.title, createdAt: chatSession.createdAt };
}
