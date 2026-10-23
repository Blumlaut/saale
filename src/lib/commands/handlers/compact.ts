import { compactChatSession, compactionOutcome } from "@/lib/chat/compact-chat";
import { compactTelegramSession } from "@/lib/telegram/processor";
import type { CommandHandler } from "../types";

/** `/compact`. summarise the conversation to free up context. */
export const compactHandler: CommandHandler = {
  run: async (ctx) => {
    if (ctx.surface === "telegram") {
      return compactTelegramSession({
        userId: ctx.userId,
        telegramChatId: ctx.telegramChatId,
        sessionId: ctx.sessionId ?? null,
      });
    }

    return compactionOutcome(
      await compactChatSession({ userId: ctx.userId, sessionId: ctx.sessionId }),
    );
  },
};
