import { clearQueuedMessages } from "@/lib/chat/queue";
import { stopChatGeneration } from "@/lib/chat/stop-generation";
import { interruptTelegramChat, isTelegramSessionActive } from "@/lib/telegram/session-registry";
import type { CommandHandler } from "../types";

/**
 * `/stop clear:true`. cancel whatever the agent is generating right now, and
 * optionally drop what was queued behind it.
 */
export const stopHandler: CommandHandler = {
  run: async (ctx) => {
    if (ctx.surface === "telegram") {
      const wasActive = isTelegramSessionActive(ctx.userId, ctx.telegramChatId);
      if (wasActive) {
        await interruptTelegramChat(ctx.userId, ctx.telegramChatId);
        return { message: withCleared("Stopped.", await clearQueue(ctx)), tone: "info" };
      }
      // A run started from the web in this same chat is not in the Telegram
      // registry. stop it through the chat instead.
      if (!ctx.sessionId) return { message: "Nothing is running.", tone: "info" };
      const stopped = await stopChatGeneration(ctx.userId, ctx.sessionId);
      return {
        message: withCleared(stopped ? "Stopped." : "Nothing is running.", await clearQueue(ctx)),
        tone: "info",
      };
    }

    const stopped = await stopChatGeneration(ctx.userId, ctx.sessionId);
    return {
      message: withCleared(stopped ? "Stopped." : "Nothing is running.", await clearQueue(ctx)),
      tone: "info",
      refresh: "generation",
    };
  },
};

/** How many queued messages the command was asked to drop. */
async function clearQueue(ctx: {
  userId: string;
  sessionId?: string | undefined;
  arguments: Readonly<Record<string, string>>;
}): Promise<number> {
  if (ctx.arguments.clear !== "true" || !ctx.sessionId) return 0;
  return clearQueuedMessages(ctx.userId, ctx.sessionId);
}

/** The stop message, saying how much of the queue went with it. */
function withCleared(message: string, cleared: number): string {
  if (cleared === 0) return message;
  return `${message} Dropped ${cleared} queued ${cleared === 1 ? "message" : "messages"}.`;
}
