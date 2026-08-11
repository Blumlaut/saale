import { prisma } from "@/lib/db";

/**
 * Telegram chat resolution helpers.
 *
 * Agent jobs can route their output to Telegram either with an explicit
 * chat ID or by inheriting the user's configured chat. "Configured" means:
 * the most recently active TelegramChat (a real conversation the bot has
 * been in — delivery is guaranteed to work), falling back to the most
 * recently whitelisted Telegram user ID (for private chats, the chat ID
 * equals the user ID, so this covers a whitelist set up before the user
 * has messaged the bot).
 */

/** A Telegram chat the bot can send to, with a human-readable label. */
export interface TelegramChatInfo {
  /** Chat ID as a string (Telegram chat IDs can exceed JS safe integers). */
  chatId: string;
  /** Display label (whitelist display name for private chats, else chat type). */
  label: string;
  /** "private" | "group" */
  chatType: string;
}

/**
 * Resolve the user's configured Telegram chat ID for a given account.
 *
 * Prefers the most recently active TelegramChat; falls back to the most
 * recently whitelisted user ID. Returns null when neither exists.
 */
export async function resolveDefaultTelegramChat(accountId: string): Promise<bigint | null> {
  const chat = await prisma.telegramChat.findFirst({
    where: { telegramAccountId: accountId },
    select: { telegramChatId: true },
    orderBy: { updatedAt: "desc" },
  });
  if (chat) return chat.telegramChatId;

  const whitelistEntry = await prisma.telegramWhitelist.findFirst({
    where: { telegramAccountId: accountId },
    select: { telegramUserId: true },
    orderBy: { createdAt: "desc" },
  });
  return whitelistEntry?.telegramUserId ?? null;
}

/**
 * Resolve the user's configured Telegram chat with a display label.
 *
 * Same resolution as {@link resolveDefaultTelegramChat} but returns
 * string-form chat ID plus a human-readable label for UI display.
 */
export async function getDefaultTelegramChatInfo(
  accountId: string,
): Promise<{ chatId: string; label: string } | null> {
  const chatId = await resolveDefaultTelegramChat(accountId);
  if (chatId === null) return null;

  const whitelistEntry = await prisma.telegramWhitelist.findUnique({
    where: {
      telegramAccountId_telegramUserId: {
        telegramAccountId: accountId,
        telegramUserId: chatId,
      },
    },
    select: { displayName: true },
  });

  return {
    chatId: chatId.toString(),
    label: whitelistEntry?.displayName ?? "Configured chat",
  };
}

/**
 * List the user's known Telegram chats (most recent first) with labels.
 *
 * Labels use the whitelist display name when the chat matches a whitelisted
 * user (private chats), otherwise fall back to the chat type.
 */
export async function listTelegramChats(accountId: string): Promise<TelegramChatInfo[]> {
  const [chats, whitelist] = await Promise.all([
    prisma.telegramChat.findMany({
      where: { telegramAccountId: accountId },
      orderBy: { updatedAt: "desc" },
      select: { telegramChatId: true, chatType: true },
    }),
    prisma.telegramWhitelist.findMany({
      where: { telegramAccountId: accountId },
      select: { telegramUserId: true, displayName: true },
    }),
  ]);

  const nameByUserId = new Map(whitelist.map((entry) => [entry.telegramUserId, entry.displayName]));

  return chats.map((chat) => ({
    chatId: chat.telegramChatId.toString(),
    label:
      nameByUserId.get(chat.telegramChatId) ??
      (chat.chatType === "group" ? "Group chat" : "Private chat"),
    chatType: chat.chatType,
  }));
}
