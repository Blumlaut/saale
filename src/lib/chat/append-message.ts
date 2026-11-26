import type { ChatMessage, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * Add a message to a chat and move the chat's metadata with it.
 *
 * Every server path that writes a turn does the same two steps in this order:
 * the row, then the session's activity and count. A path that also names the
 * chat (a title from the prompt, a queued flag, attachments) passes that along.
 */
export async function appendChatMessage(options: {
  sessionId: string;
  /** The chat's owner, when the caller knows it: the session update is scoped to them. */
  userId?: string;
  role: "user" | "system";
  content: string;
  /** Whatever else this path writes to the session with the message. */
  sessionData?: Prisma.ChatSessionUpdateInput | null;
}): Promise<ChatMessage> {
  const message = await prisma.chatMessage.create({
    data: { sessionId: options.sessionId, role: options.role, content: options.content },
  });

  await prisma.chatSession.update({
    where: { id: options.sessionId, ...(options.userId ? { userId: options.userId } : {}) },
    data: {
      lastActivityAt: new Date(),
      messageCount: { increment: 1 },
      ...options.sessionData,
    },
  });

  return message;
}
