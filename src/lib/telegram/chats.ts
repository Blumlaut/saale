import type { TelegramChat } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getTelegramBot } from "./bot";
import { getTelegramChatInfo, leaveTelegramChat } from "./client";
import { getLinkByUserId, type TelegramLinkInfo } from "./links";

/**
 * The groups the bot may post into.
 *
 * A row exists only because a linked user added the bot to that group (see
 * `group-events.ts`), so `ownerUserId` is the whole permission model: a send
 * target is valid when it names one of the caller's rows, and nothing else.
 * `chatId` is unique, which is what keeps a second user from claiming a group
 * that already has an owner.
 */

/** How long a cached title and member count stay fresh before `getChat` again. */
const CHAT_SYNC_TTL_MS = 24 * 60 * 60 * 1000;

/** A group as the console lists it. */
export interface TelegramChatView {
  chatId: string;
  title: string | null;
  kind: string;
  memberCount: number | null;
  enabled: boolean;
}

/** A resolved destination for an outbound message. */
export interface TelegramSendTarget {
  chatId: bigint;
  /** A title for the group, or the sender's name for a private chat. */
  label: string | null;
  group: boolean;
}

/** Why a target could not be resolved. The message is meant for the model. */
export class TelegramTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramTargetError";
  }
}

/** Refresh rows whose cached metadata has aged out. Failures keep what is cached. */
async function refreshStaleChats(chats: TelegramChat[]): Promise<TelegramChat[]> {
  const stale = chats.filter(
    (chat) =>
      chat.enabled &&
      (chat.syncedAt === null || Date.now() - chat.syncedAt.getTime() > CHAT_SYNC_TTL_MS),
  );
  if (stale.length === 0) return chats;

  const bot = await getTelegramBot();
  if (!bot?.enabled) return chats;

  const refreshed = new Map<string, TelegramChat>();
  for (const chat of stale) {
    try {
      const info = await getTelegramChatInfo(bot.encryptedToken, chat.chatId);
      refreshed.set(
        chat.id,
        await prisma.telegramChat.update({
          where: { id: chat.id },
          data: {
            title: info.title,
            kind: info.kind,
            memberCount: info.memberCount,
            syncedAt: new Date(),
          },
        }),
      );
    } catch (err) {
      // The cached title is better than none, and the bot may simply have been
      // removed from the group.
      console.warn(`[telegram] Failed to refresh group ${chat.chatId}:`, err);
    }
  }

  return chats.map((chat) => refreshed.get(chat.id) ?? chat);
}

/** The caller's groups, newest metadata first. */
export async function listTelegramChats(ownerUserId: string): Promise<TelegramChat[]> {
  const chats = await prisma.telegramChat.findMany({
    where: { ownerUserId },
    orderBy: { createdAt: "asc" },
  });
  return refreshStaleChats(chats);
}

/** The row for a Telegram chat, whoever owns it. Used by the webhook. */
export async function getTelegramChatByChatId(chatId: bigint): Promise<TelegramChat | null> {
  return prisma.telegramChat.findUnique({ where: { chatId } });
}

/** The caller's groups, as the console and the tool render them. */
export function toChatView(chat: TelegramChat): TelegramChatView {
  return {
    chatId: chat.chatId.toString(),
    title: chat.title,
    kind: chat.kind,
    memberCount: chat.memberCount,
    enabled: chat.enabled,
  };
}

/**
 * Remove a group from the caller's list and leave it.
 *
 * The row goes first: a leave that Telegram refuses (the bot is already out)
 * must not leave a target that can never deliver.
 */
export async function removeTelegramChat(params: {
  ownerUserId: string;
  chatId: bigint;
}): Promise<boolean> {
  const { ownerUserId, chatId } = params;

  const { count } = await prisma.telegramChat.deleteMany({ where: { ownerUserId, chatId } });
  if (count === 0) return false;

  const bot = await getTelegramBot();
  if (!bot) return true;

  await leaveTelegramChat(bot.encryptedToken, chatId).catch((err) => {
    console.error(`[telegram] Failed to leave chat ${chatId}:`, err);
  });
  return true;
}

/** Parse a chat id the model was given. Returns null when it is not a number. */
function parseChatId(target: string): bigint | null {
  const raw = target.trim();
  if (!/^-?\d+$/.test(raw)) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

/** Name the caller's groups, so a wrong target is correctable in one turn. */
async function describeAvailableGroups(ownerUserId: string): Promise<string> {
  const groups = await prisma.telegramChat.findMany({
    where: { ownerUserId, enabled: true },
    select: { chatId: true, title: true },
  });

  if (groups.length === 0) {
    return "No groups are connected, so the only target is the user's own chat.";
  }

  const names = groups.map((group) => `"${group.title ?? "untitled"}" (${group.chatId})`);
  return `Available groups: ${names.join(", ")}.`;
}

/**
 * The chat a message goes to.
 *
 * Without a target it is the user's linked private chat, which is what every
 * delivery did before groups existed. With one it must name a group the caller
 * owns and the bot is still in, so an id from another account or a stale list
 * cannot be used to post somewhere.
 */
export async function resolveTelegramSendTarget(params: {
  userId: string;
  target?: string | null | undefined;
  /** The caller's link, when it already has it. */
  link?: TelegramLinkInfo | null | undefined;
}): Promise<TelegramSendTarget> {
  const { userId, target } = params;

  if (target == null || target.trim() === "") {
    const link = params.link ?? (await getLinkByUserId(userId));
    if (!link) {
      throw new TelegramTargetError(
        "This account has not linked a Telegram account yet. Link one in Settings → Integrations → Telegram.",
      );
    }
    return { chatId: link.telegramChatId, label: link.displayName, group: false };
  }

  const chatId = parseChatId(target);
  const chat = chatId === null ? null : await getTelegramChatByChatId(chatId);

  if (!chat || chat.ownerUserId !== userId) {
    throw new TelegramTargetError(
      `Unknown Telegram target "${target}". ${await describeAvailableGroups(userId)}`,
    );
  }

  if (!chat.enabled) {
    throw new TelegramTargetError(
      `The bot is no longer in "${chat.title ?? "that group"}". Remove it from the list or add the bot again.`,
    );
  }

  return { chatId: chat.chatId, label: chat.title, group: true };
}
