import { prisma } from "@/lib/db";

export async function saveAssistantMessage(
  sessionId: string,
  content: string,
  thinking?: string,
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    result: string | undefined;
    isError: boolean | undefined;
  }>,
  parentMessageId?: string | null,
  messageId?: string,
): Promise<{ id: string }> {
  // If a message ID is provided, update the existing message (agent_end finalization)
  if (messageId) {
    const msg = await prisma.chatMessage.update({
      where: { id: messageId },
      data: {
        content,
        thinking: thinking || null,
        toolCalls: toolCalls && toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
      },
    });
    return { id: msg.id };
  }

  return prisma.chatMessage.create({
    data: {
      sessionId,
      role: "assistant",
      content,
      thinking: thinking || null,
      toolCalls: toolCalls && toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
      parentMessageId: parentMessageId || null,
    },
  });
}
