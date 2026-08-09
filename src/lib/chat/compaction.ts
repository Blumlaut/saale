import { prisma } from "@/lib/db";

/**
 * Save a compaction summary as a chat message so it appears in the UI.
 *
 * `tokensBefore` is stored in the `thinking` field (repurposed for compaction metadata).
 */
export async function saveCompactionMessage({
  sessionId,
  summary,
  tokensBefore,
}: {
  sessionId: string;
  summary: string;
  tokensBefore?: number;
}): Promise<void> {
  try {
    await prisma.chatMessage.create({
      data: {
        sessionId,
        role: "compaction",
        content: summary,
        thinking: String(tokensBefore ?? 0),
        toolCalls: null,
        parentMessageId: null,
      },
    });

    // A compaction summary is new chat content — advance lastActivityAt so
    // the session list reflects it.
    await prisma.chatSession
      .update({
        where: { id: sessionId },
        data: { lastActivityAt: new Date() },
      })
      .catch((err) => {
        console.error(`Failed to bump lastActivityAt after compaction for ${sessionId}:`, err);
      });
  } catch (err) {
    console.error("Failed to save compaction message:", err);
  }
}
