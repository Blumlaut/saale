import { stopChatGeneration } from "@/lib/chat/stop-generation";
import { interruptTelegramChat, isTelegramSessionActive } from "@/lib/telegram/session-registry";
import type { CommandHandler } from "../types";

/** `/stop` — cancel whatever the agent is generating right now. */
export const stopHandler: CommandHandler = {
  run: async (ctx) => {
    if (ctx.surface === "telegram") {
      const wasActive = isTelegramSessionActive(ctx.userId, ctx.telegramChatId);
      await interruptTelegramChat(ctx.userId, ctx.telegramChatId);
      return { message: wasActive ? "Stopped." : "Nothing is running.", tone: "info" };
    }

    const stopped = await stopChatGeneration(ctx.userId, ctx.sessionId);
    return {
      message: stopped ? "Stopped." : "Nothing is running.",
      tone: "info",
      refresh: "generation",
    };
  },
};
