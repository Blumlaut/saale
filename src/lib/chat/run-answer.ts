/**
 * Whether a user message already has the answer that ended its run.
 *
 * A run continues past an assistant turn that called tools: the model reads the
 * results and goes on. Only a turn that ends without a call can be a run's last
 * word, which is what makes this the right test for a message whose run record
 * is still around. an answer means the run did its job and only its record is
 * left over.
 */

import { prisma } from "@/lib/db";

/**
 * @param sessionId - The chat.
 * @param since - Where the run's own turns begin: its user message's timestamp,
 * or the recorded start of the run.
 */
export async function hasFinalAnswer(sessionId: string, since: Date): Promise<boolean> {
  const answer = await prisma.chatMessage.findFirst({
    where: {
      sessionId,
      role: "assistant",
      createdAt: { gt: since },
      toolCalls: null,
      content: { not: "" },
    },
    select: { id: true },
  });
  return answer !== null;
}
