import type { ChatAttachment, ChatMessage } from "@prisma/client";
import type { AttachmentData, Message } from "@/components/chat/types";

/**
 * DB row → client message shape.
 *
 * Chat messages are rendered by the conversation view AND by the send queue,
 * so the mapping lives here instead of being duplicated per endpoint.
 */

export type ChatMessageWithAttachments = ChatMessage & { attachments: ChatAttachment[] };

/** A row that is guaranteed to be in the send queue. */
export type QueuedChatMessage = ChatMessageWithAttachments & { queuedAt: Date };

export function serializeAttachment(a: ChatAttachment): AttachmentData {
  return {
    id: a.id,
    storageId: a.storageId,
    fileName: a.fileName,
    mimeType: a.mimeType,
    size: a.size,
    ...(a.width !== null ? { width: a.width } : {}),
    ...(a.height !== null ? { height: a.height } : {}),
  };
}

export function serializeChatMessage(message: ChatMessageWithAttachments): Message {
  return {
    id: message.id,
    role: message.role as Message["role"],
    content: message.content,
    thinking: message.thinking || undefined,
    errorMessage: message.errorMessage || undefined,
    toolCalls: message.toolCalls
      ? JSON.parse(message.toolCalls).map((tc: { isError?: boolean }) => ({
          ...tc,
          status: tc.isError ? ("error" as const) : ("completed" as const),
        }))
      : undefined,
    parentMessageId: message.parentMessageId || undefined,
    createdAt: message.createdAt.toISOString(),
    attachments: message.attachments.map(serializeAttachment),
    ...(message.role === "compaction"
      ? { compaction: { tokensBefore: message.thinking ? parseInt(message.thinking, 10) : 0 } }
      : {}),
  };
}
