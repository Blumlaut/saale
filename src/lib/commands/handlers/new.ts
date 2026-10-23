import { createChatSessionRow } from "@/lib/chat/create-session";
import { setActiveTelegramSession } from "@/lib/telegram/links";
import type { CommandHandler } from "../types";

/**
 * `/new`. start a chat from Telegram.
 *
 * Telegram runs messages in ordinary chats, so this is the phone's "New chat"
 * button: it creates one and points the link at it, and the next message runs
 * there.
 */
export const newHandler: CommandHandler = {
  run: async (ctx) => {
    if (ctx.surface !== "telegram") {
      return { message: "Start a new chat from the sidebar.", tone: "info" };
    }

    const session = await createChatSessionRow(ctx.userId);
    await setActiveTelegramSession(ctx.userId, session.id);

    return { message: "Started a new chat. Send your message.", tone: "success" };
  },
};
