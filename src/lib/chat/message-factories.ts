import type { Message } from "@/components/chat/types";

/**
 * Message factories and ID-prefix predicates shared by the chat UI.
 *
 * Message IDs encode where a message lives:
 * - `temp-*` (role user) — optimistic copy while POST /messages is in flight
 * - `temp-compaction-*` (role compaction) — optimistic compaction placeholder
 * - `streaming-{turnId}` — live assistant turn not yet saved to the DB
 * - anything else — a real DB message id
 *
 * Centralizing the prefixes (instead of scattering `id.startsWith(...)`
 * checks) keeps the scheme consistent across the chat components and the
 * merge/stream logic.
 */

export function isStreamingMessage(m: Pick<Message, "id">): boolean {
  return m.id.startsWith("streaming-");
}

export function isTempMessage(m: Pick<Message, "id">): boolean {
  return m.id.startsWith("temp-");
}

/** Optimistic copy of a user message whose POST is still in flight. */
export function isTempUserMessage(m: Pick<Message, "id" | "role">): boolean {
  return m.role === "user" && m.id.startsWith("temp-");
}

/** Optimistic user message shown while POST /messages is in flight. */
export function makeTempUserMessage(content: string, files?: File[]): Message {
  return {
    id: `temp-${Date.now()}`,
    role: "user",
    content,
    thinking: undefined,
    errorMessage: undefined,
    toolCalls: undefined,
    parentMessageId: undefined,
    createdAt: new Date().toISOString(),
    attachments:
      files?.map((f) => ({
        id: `temp-${f.name}-${f.size}`,
        storageId: `temp-${f.name}`,
        fileName: f.name,
        mimeType: f.type,
        size: f.size,
      })) ?? undefined,
  };
}

/**
 * Live assistant turn for an SSE stream event. `patch` lets callers seed
 * content/thinking/tool calls when the creating event already carries them
 * (e.g. `token` arrives without a preceding `turn_start` during a replay).
 */
export function makeStreamingMessage(
  turnId: string,
  parentMessageId: string | undefined,
  patch?: Partial<Message>,
): Message {
  return {
    id: `streaming-${turnId}`,
    role: "assistant",
    content: "",
    thinking: undefined,
    errorMessage: undefined,
    toolCalls: undefined,
    parentMessageId: parentMessageId || undefined,
    createdAt: new Date().toISOString(),
    attachments: undefined,
    ...patch,
  };
}

/** Compaction summary message (real or optimistic placeholder). */
export function makeCompactionMessage(content: string, tokensBefore: number, id?: string): Message {
  return {
    id: id ?? `compaction-${Date.now()}`,
    role: "compaction",
    content,
    thinking: undefined,
    errorMessage: undefined,
    toolCalls: undefined,
    parentMessageId: undefined,
    createdAt: new Date().toISOString(),
    attachments: undefined,
    compaction: { tokensBefore },
  };
}
