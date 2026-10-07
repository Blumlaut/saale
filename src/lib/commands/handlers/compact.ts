import { compactChatSession } from "@/lib/chat/compact-chat";
import { compactTelegramSession } from "@/lib/telegram/processor";
import type { CommandHandler } from "../types";

/** `/compact` — summarise the conversation to free up context. */
export const compactHandler: CommandHandler = {
  run: async (ctx) => {
    if (ctx.surface === "telegram") {
      return compactTelegramSession({
        userId: ctx.userId,
        telegramChatId: ctx.telegramChatId,
      });
    }

    const result = await compactChatSession({ userId: ctx.userId, sessionId: ctx.sessionId });

    if (!result.ok) {
      // "already compacted" and "too short" are states, not failures.
      const informational =
        result.code === "already-compacted" || result.code === "nothing-to-compact";
      return { message: result.message, tone: informational ? "info" : "error" };
    }

    const tokensInfo = result.tokensBefore
      ? ` (was ${result.tokensBefore.toLocaleString()} tokens)`
      : "";
    return {
      message: `Conversation compacted${tokensInfo}.`,
      tone: "success",
      refresh: "messages",
    };
  },
};
