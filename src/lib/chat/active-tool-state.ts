import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * Clear the in-progress tool bookkeeping a chat session carries in the DB.
 *
 * The session event tracker writes it at `tool_execution_start` and clears it
 * at `tool_execution_end`, so it survives only as long as the run that set it.
 * A generation that dies mid-flight (restart, crash, killed container) leaves
 * it set with nothing behind it, and the messages endpoint reports it as an
 * active tool for as long as the session looks busy. a phantom "Running …".
 *
 * Recovery paths call this when they take over a session whose run is gone,
 * so a refresh never shows a tool that is not running, and a resumed run never
 * inherits the previous one's tool.
 */
export async function clearActiveToolState(sessionId: string, userId: string): Promise<void> {
  await prisma.chatSession.updateMany({
    where: { id: sessionId, userId },
    data: {
      activeToolCallId: null,
      activeToolName: null,
      activeToolArgs: Prisma.JsonNull,
      activeToolStartedAt: null,
    },
  });
}
