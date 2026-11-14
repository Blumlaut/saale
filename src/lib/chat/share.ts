import crypto from "crypto";
import { prisma } from "@/lib/db";
import { DEFAULT_SHARE_ACCESS } from "@/lib/chat/share-access";
import {
  serializeSharedChatMessage,
  type ShareableChatMessage,
} from "@/lib/chat/serialize-message";
import type { Message } from "@/components/chat/types";

/**
 * Generate a random 32-character share token.
 */
export function generateShareToken(): string {
  return crypto.randomBytes(16).toString("hex");
}

/** The session fields a share page shows. */
export interface SharedChatSession {
  id: string;
  title: string;
  createdAt: Date;
}

export type SharedChat =
  | { state: "ok"; session: SharedChatSession; messages: Message[] }
  | { state: "not-found" }
  | { state: "needs-auth" };

/** The columns a share payload is built from. Select exactly these. */
const SHARE_MESSAGE_SELECT = {
  id: true,
  role: true,
  content: true,
  thinking: true,
  errorMessage: true,
  toolCalls: true,
  parentMessageId: true,
  createdAt: true,
} satisfies Record<keyof ShareableChatMessage, true>;

/**
 * The shared chat behind `token`, as `viewerId` is allowed to see it.
 *
 * The access decision comes before the messages are read, so a gated chat never
 * loads a row for a visitor it is about to turn away.
 */
export async function loadSharedChat(token: string, viewerId: string | null): Promise<SharedChat> {
  const session = await prisma.chatSession.findFirst({
    where: { shareToken: token, shared: true },
    select: { id: true, title: true, createdAt: true, shareAccess: true },
  });

  if (!session) return { state: "not-found" };

  // Fail closed: a value this build does not recognise needs a signed-in viewer.
  const gated = session.shareAccess !== DEFAULT_SHARE_ACCESS;
  if (gated && !viewerId) return { state: "needs-auth" };

  const messages = await prisma.chatMessage.findMany({
    where: { sessionId: session.id, queuedAt: null },
    orderBy: { createdAt: "asc" },
    select: SHARE_MESSAGE_SELECT,
  });

  return {
    state: "ok",
    session: { id: session.id, title: session.title, createdAt: session.createdAt },
    messages: messages.map((message) => serializeSharedChatMessage(message, token)),
  };
}
