import { prisma } from "@/lib/db";
import { TELEGRAM_BOT_ID } from "./bot";
import {
  buildGroupAddedMessage,
  buildGroupRefusedMessage,
  getTelegramChatInfo,
  leaveTelegramChat,
  sendTelegramMessage,
} from "./client";
import { getTelegramChatByChatId } from "./chats";
import { getLinkByTelegramUserId } from "./links";

/**
 * Group membership, decided from the service messages Telegram sends.
 *
 * The bot is send-only in groups: it never reads group content, and the only
 * thing it acts on is who put it there. `new_chat_members` carries the adder in
 * `message.from`, and bots receive every service message regardless of privacy
 * mode, so that is enough to decide ownership without reading a word anyone
 * typed.
 *
 * The bot stays in a group only when a linked Saale user added it. Anything
 * else is refused with one line and a `leaveChat`, so a group can never become
 * a place where one user's agent posts for another.
 */

/** The fields of a group message this module reads. */
export interface GroupServiceMessage {
  chat: { id: number; type: string; title?: string | undefined };
  from?: { id: number; first_name?: string; last_name?: string } | undefined;
  message_id: number;
  new_chat_members?: Array<{ id: number; is_bot?: boolean | undefined }> | undefined;
  left_chat_member?: { id: number; is_bot?: boolean | undefined } | undefined;
  new_chat_title?: string | undefined;
  migrate_to_chat_id?: number | undefined;
  migrate_from_chat_id?: number | undefined;
}

/** Tell the group why, then leave it. The refusal must land before the exit. */
async function refuseAndLeave(encryptedToken: string, chatId: bigint): Promise<void> {
  await sendTelegramMessage(encryptedToken, chatId, buildGroupRefusedMessage(), {
    parseMode: "HTML",
  }).catch((err) => {
    console.error(`[telegram] Failed to send the group refusal to ${chatId}:`, err);
  });

  await leaveTelegramChat(encryptedToken, chatId).catch((err) => {
    console.error(`[telegram] Failed to leave group ${chatId}:`, err);
  });
}

/**
 * A linked user added the bot: register the group, or keep it as it is.
 *
 * Ownership never moves. A group that already has an owner is refused when
 * someone else adds the bot, and re-enabled when its owner adds it back.
 */
async function onBotAdded(params: {
  message: GroupServiceMessage;
  chatId: bigint;
  encryptedToken: string;
}): Promise<void> {
  const { message, chatId, encryptedToken } = params;

  // Telegram omits `from` when a bot or an invite link did the adding. Nobody
  // can be held to that, so the bot does not stay.
  if (!message.from) {
    await refuseAndLeave(encryptedToken, chatId);
    return;
  }

  const link = await getLinkByTelegramUserId(BigInt(message.from.id));
  if (!link) {
    await refuseAndLeave(encryptedToken, chatId);
    return;
  }

  const existing = await getTelegramChatByChatId(chatId);
  if (existing && existing.ownerUserId !== link.userId) {
    await refuseAndLeave(encryptedToken, chatId);
    return;
  }

  if (existing) {
    const info = await getTelegramChatInfo(encryptedToken, chatId).catch((err) => {
      console.warn(`[telegram] Failed to read group ${chatId} on re-add:`, err);
      return null;
    });

    await prisma.telegramChat.update({
      where: { id: existing.id },
      data: {
        enabled: true,
        ...(info
          ? {
              title: info.title,
              kind: info.kind,
              memberCount: info.memberCount,
              syncedAt: new Date(),
            }
          : {}),
      },
    });
    return;
  }

  const info = await getTelegramChatInfo(encryptedToken, chatId).catch((err) => {
    console.warn(`[telegram] Failed to read group ${chatId} while registering it:`, err);
    return null;
  });

  // Upsert rather than create: a duplicate update and this one can race, and an
  // existing row is never reassigned.
  await prisma.telegramChat.upsert({
    where: { chatId },
    create: {
      botId: TELEGRAM_BOT_ID,
      ownerUserId: link.userId,
      chatId,
      title: info?.title ?? message.chat.title ?? null,
      kind: info?.kind ?? message.chat.type,
      memberCount: info?.memberCount ?? null,
      syncedAt: info ? new Date() : null,
    },
    update: {},
  });

  await sendTelegramMessage(
    encryptedToken,
    link.telegramChatId,
    buildGroupAddedMessage(info?.title ?? message.chat.title ?? null),
    { parseMode: "HTML" },
  ).catch((err) => {
    console.error(`[telegram] Failed to confirm the group add to user ${link.userId}:`, err);
  });
}

/**
 * A group was upgraded to a supergroup and its id changed.
 *
 * Telegram sends the new id to the old chat and the old id to the new one, so
 * both directions are handled and each is a no-op once the row has moved. The
 * stored send targets follow, or a job would keep posting into an id that no
 * longer exists.
 */
async function migrateChat(params: { oldChatId: bigint; newChatId: bigint }): Promise<void> {
  const { oldChatId, newChatId } = params;
  if (oldChatId === newChatId) return;

  const row = await getTelegramChatByChatId(oldChatId);
  if (!row) return;

  const oldTarget = oldChatId.toString();
  const newTarget = newChatId.toString();

  try {
    await prisma.$transaction([
      prisma.telegramChat.update({
        where: { id: row.id },
        data: { chatId: newChatId, syncedAt: null },
      }),
      prisma.agentDefinition.updateMany({
        where: { userId: row.ownerUserId, outputChannelId: oldTarget },
        data: { outputChannelId: newTarget },
      }),
      prisma.agentRun.updateMany({
        where: { userId: row.ownerUserId, outputChannelId: oldTarget },
        data: { outputChannelId: newTarget },
      }),
    ]);
  } catch (err) {
    console.error(`[telegram] Failed to migrate group ${oldChatId} to ${newChatId}:`, err);
  }
}

/**
 * Handle a message from a group.
 *
 * Only membership and identity service messages are read. Everything else in a
 * group is ignored: a group member's text is never a prompt for anyone's agent.
 */
export async function handleGroupServiceMessage(params: {
  message: GroupServiceMessage;
  /** The bot's own Telegram id, so a member list can be read for itself. */
  botId: bigint | null;
  encryptedToken: string;
}): Promise<void> {
  const { message, botId, encryptedToken } = params;
  const chatId = BigInt(message.chat.id);

  const addedTheBot =
    botId !== null &&
    (message.new_chat_members ?? []).some((member) => BigInt(member.id) === botId);

  if (addedTheBot) {
    await onBotAdded({ message, chatId, encryptedToken });
    return;
  }

  if (message.migrate_to_chat_id != null) {
    const row = await getTelegramChatByChatId(chatId);
    if (row) {
      await migrateChat({ oldChatId: chatId, newChatId: BigInt(message.migrate_to_chat_id) });
    }
    return;
  }

  if (message.migrate_from_chat_id != null) {
    const row = await getTelegramChatByChatId(BigInt(message.migrate_from_chat_id));
    if (row) {
      await migrateChat({ oldChatId: BigInt(message.migrate_from_chat_id), newChatId: chatId });
    }
    return;
  }

  // Everything below is about a group the bot already belongs to.
  const chat = await getTelegramChatByChatId(chatId);
  if (!chat) return;

  if (message.new_chat_title != null) {
    await prisma.telegramChat
      .update({
        where: { id: chat.id },
        data: { title: message.new_chat_title, syncedAt: new Date() },
      })
      .catch((err) => {
        console.error(`[telegram] Failed to update the title of group ${chatId}:`, err);
      });
    return;
  }

  const leftTheBot =
    botId !== null &&
    message.left_chat_member != null &&
    BigInt(message.left_chat_member.id) === botId;

  if (leftTheBot) {
    await prisma.telegramChat
      .update({
        where: { id: chat.id },
        data: { enabled: false },
      })
      .catch((err) => {
        console.error(`[telegram] Failed to mark group ${chatId} as left:`, err);
      });
  }
}
