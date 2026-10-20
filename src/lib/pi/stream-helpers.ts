import { prisma } from "@/lib/db";

/** A tool call as persisted on an assistant message. */
export interface SavedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result: string | undefined;
  isError: boolean | undefined;
}

export interface SaveAssistantMessageInput {
  sessionId: string;
  content: string;
  thinking?: string | undefined;
  toolCalls?: SavedToolCall[] | undefined;
  parentMessageId?: string | null | undefined;
  /** When set, the existing message is updated instead of a new one created. */
  messageId?: string | undefined;
  /** Provider error when the turn failed. drives the UI's error notice. */
  errorMessage?: string | null | undefined;
  /**
   * When the turn began. the row's conversation position. Defaults to now.
   *
   * A turn's row is only written at `turn_end`, but its place in the
   * conversation is where the turn started: a message delivered into the run
   * mid-turn (a steered "send now") belongs after this turn, and stamping the
   * row with its save time would sort that message above it.
   */
  createdAt?: Date | undefined;
}

/**
 * Persist an assistant turn.
 *
 * Update semantics: a turn that failed mid-run is first created by `turn_end`
 * and then finalized by `agent_end`, so the last write replaces the whole
 * message. `errorMessage` is set to null when absent rather than left stale.
 */
export async function saveAssistantMessage(
  input: SaveAssistantMessageInput,
): Promise<{ id: string }> {
  const {
    sessionId,
    content,
    thinking,
    toolCalls,
    parentMessageId,
    messageId,
    errorMessage,
    createdAt,
  } = input;

  const data = {
    content,
    thinking: thinking || null,
    toolCalls: toolCalls && toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
    errorMessage: errorMessage || null,
  };

  if (messageId) {
    const msg = await prisma.chatMessage.update({
      where: { id: messageId, sessionId },
      data,
    });
    return { id: msg.id };
  }

  return prisma.chatMessage.create({
    data: {
      sessionId,
      role: "assistant",
      ...data,
      parentMessageId: parentMessageId || null,
      ...(createdAt ? { createdAt } : {}),
    },
  });
}
