import { compactChatSession, compactionOutcome } from "@/lib/chat/compact-chat";
import type { CommandHandler } from "../types";

/** `/compact`. summarise the conversation to free up context. */
export const compactHandler: CommandHandler = {
  run: async (ctx) => {
    if (!ctx.sessionId) {
      return { message: "This message doesn't belong to a chat yet.", tone: "info" };
    }

    return compactionOutcome(
      await compactChatSession({ userId: ctx.userId, sessionId: ctx.sessionId }),
    );
  },
};
