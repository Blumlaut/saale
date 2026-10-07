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
 * A resolved destination for proactive messages, and why it was chosen.
 */
export interface TelegramNotifyChat {
  chatId: bigint;
  /** Display label (whitelist display name, else a generic one). */
  label: string;
  /** How the chat was picked — `pinned` means the user chose it explicitly. */
  source: "pinned" | "private" | "whitelist";
}

/** Display label for a chat — the whitelist name when the chat is a known user. */
async function labelForChat(accountId: string, chatId: bigint): Promise<string> {
  const entry = await prisma.telegramWhitelist.findUnique({
    where: {
      telegramAccountId_telegramUserId: {
        telegramAccountId: accountId,
        telegramUserId: chatId,
      },
    },
    select: { displayName: true },
  });
  return entry?.displayName ?? "Telegram chat";
}

/**
 * Resolve the chat proactive messages (reminders, agent job output) go to.
 *
 * 1. `pinnedChatId` — the chat the user pinned in the Telegram integration.
 * 2. The most recently active **private** chat.
 * 3. The most recently whitelisted user (a private chat's ID is the user's ID).
 *
 * Groups are deliberately excluded from automatic resolution: a message meant
 * for the owner must not land in a group the bot happens to sit in. Only an
 * explicit pin can target one. This differs from
 * {@link resolveDefaultTelegramChat}, which keeps its "most recent chat of any
 * type" behaviour for agent job output the user configured on purpose.
 *
 * @param accountId - The TelegramAccount.id to resolve against
 * @param pinnedChatId - The account's `notifyChatId`, or null when unset
 * @returns The resolved chat, or null when the account has no usable target
 */
export async function resolveNotifyChat(
  accountId: string,
  pinnedChatId: bigint | null,
): Promise<TelegramNotifyChat | null> {
  if (pinnedChatId !== null) {
    return {
      chatId: pinnedChatId,
      label: await labelForChat(accountId, pinnedChatId),
      source: "pinned",
    };
  }

  const privateChat = await prisma.telegramChat.findFirst({
    where: { telegramAccountId: accountId, chatType: "private" },
    select: { telegramChatId: true },
    orderBy: { updatedAt: "desc" },
  });
  if (privateChat) {
    return {
      chatId: privateChat.telegramChatId,
      label: await labelForChat(accountId, privateChat.telegramChatId),
      source: "private",
    };
  }

  const whitelistEntry = await prisma.telegramWhitelist.findFirst({
    where: { telegramAccountId: accountId },
    select: { telegramUserId: true, displayName: true },
    orderBy: { createdAt: "desc" },
  });
  if (whitelistEntry) {
    return {
      chatId: whitelistEntry.telegramUserId,
      label: whitelistEntry.displayName ?? "Whitelisted user",
      source: "whitelist",
    };
  }

  return null;
}

/**
 * Whether the account has actually seen this chat — either a conversation the
 * bot has been in, or a whitelisted user (whose private chat ID is their user
 * ID).
 *
 * Used to validate a pinned notification chat, so a typo cannot silently point
 * proactive messages at an unrelated chat that happens to exist.
 */
export async function isKnownTelegramChat(accountId: string, chatId: bigint): Promise<boolean> {
  const [chat, whitelisted] = await Promise.all([
    prisma.telegramChat.findUnique({
      where: {
        telegramAccountId_telegramChatId: {
          telegramAccountId: accountId,
          telegramChatId: chatId,
        },
      },
      select: { id: true },
    }),
    prisma.telegramWhitelist.findUnique({
      where: {
        telegramAccountId_telegramUserId: {
          telegramAccountId: accountId,
          telegramUserId: chatId,
        },
      },
      select: { id: true },
    }),
  ]);

  return chat !== null || whitelisted !== null;
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
