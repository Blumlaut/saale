import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { validateBotToken, registerWebhook, deleteWebhook } from "@/lib/telegram";
import { isKnownTelegramChat, resolveNotifyChat } from "@/lib/telegram/chats";
import crypto from "crypto";

/**
 * Parse and validate a `notifyChatId` write.
 *
 * `null`/`""` clears the pin (back to automatic resolution). Anything else
 * must be a chat the account has actually seen — a pinned chat that does not
 * exist would turn every proactive message into a silent delivery failure.
 *
 * @throws When the value is not an integer, or names an unknown chat
 */
async function parseNotifyChatId(
  accountId: string,
  value: string | null | undefined,
): Promise<bigint | null> {
  if (value === null || value === undefined || value === "") return null;

  let chatId: bigint;
  try {
    chatId = BigInt(value);
  } catch {
    throw new Error("notifyChatId must be a Telegram chat ID");
  }

  if (!(await isKnownTelegramChat(accountId, chatId))) {
    throw new Error("That chat is not known to this bot — message the bot from it first");
  }

  return chatId;
}

/**
 * GET /api/integrations/telegram — Get user's Telegram integration status
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const account = await prisma.telegramAccount.findUnique({
    where: { userId: authResult.user.id },
    select: {
      id: true,
      enabled: true,
      botId: true,
      botUsername: true,
      notifyChatId: true,
      createdAt: true,
      updatedAt: true,
      _count: {
        select: { whitelistedUsers: true },
      },
    },
  });

  if (!account) {
    return NextResponse.json({ account: null });
  }

  const notifyChat = await resolveNotifyChat(account.id, account.notifyChatId);

  return NextResponse.json({
    account: {
      id: account.id,
      enabled: account.enabled,
      botId: account.botId?.toString() ?? null,
      botUsername: account.botUsername,
      whitelistCount: account._count.whitelistedUsers,
      notifyChatId: account.notifyChatId?.toString() ?? null,
      notifyChat: notifyChat
        ? {
            chatId: notifyChat.chatId.toString(),
            label: notifyChat.label,
            source: notifyChat.source,
          }
        : null,
      createdAt: account.createdAt.toISOString(),
      updatedAt: account.updatedAt.toISOString(),
    },
  });
}

/**
 * POST /api/integrations/telegram — Create or update Telegram integration
 * Body: { token: string }
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const token = body.token as string;

  if (!token || typeof token !== "string" || token.trim().length < 10) {
    return NextResponse.json({ error: "Invalid bot token" }, { status: 400 });
  }

  const trimmedToken = token.trim();

  try {
    // Validate the token by calling Telegram's getMe
    const botInfo = await validateBotToken(trimmedToken);

    // Encrypt the token
    const encryptedToken = encrypt(trimmedToken);

    // Generate a random webhook secret
    const webhookSecret = crypto.randomBytes(32).toString("hex");

    // Upsert the account
    const account = await prisma.telegramAccount.upsert({
      where: { userId: authResult.user.id },
      create: {
        userId: authResult.user.id,
        encryptedToken,
        botId: botInfo.botId,
        botUsername: botInfo.botUsername,
        webhookSecret,
        enabled: true,
      },
      update: {
        encryptedToken,
        botId: botInfo.botId,
        botUsername: botInfo.botUsername,
        webhookSecret,
        enabled: true,
      },
    });

    // Register the webhook with Telegram
    try {
      await registerWebhook(account.encryptedToken, account.id, account.webhookSecret);
    } catch (err) {
      console.error("Failed to register Telegram webhook:", err);
      // Don't fail the whole request — the user can retry
      // The webhook can also be set manually via the Telegram Bot API
    }

    return NextResponse.json({
      account: {
        id: account.id,
        enabled: account.enabled,
        botId: account.botId?.toString() ?? null,
        botUsername: account.botUsername,
        createdAt: account.createdAt.toISOString(),
        updatedAt: account.updatedAt.toISOString(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to validate bot token";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/**
 * PATCH /api/integrations/telegram — Update Telegram integration
 * Body: { enabled?: boolean, notifyChatId?: string | null }
 *
 * `notifyChatId` pins the chat proactive messages go to; `null` restores
 * automatic resolution. Either field may be sent on its own.
 */
export async function PATCH(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const enabled = body.enabled as boolean | undefined;
  const notifyChatId = body.notifyChatId as string | null | undefined;

  if (enabled === undefined && notifyChatId === undefined) {
    return NextResponse.json(
      { error: "Missing 'enabled' or 'notifyChatId' field" },
      { status: 400 },
    );
  }

  const account = await prisma.telegramAccount.findUnique({
    where: { userId: authResult.user.id },
  });

  if (!account) {
    return NextResponse.json({ error: "No Telegram integration found" }, { status: 404 });
  }

  // If disabling, remove the webhook
  if (enabled === false) {
    try {
      await deleteWebhook(account.encryptedToken);
    } catch (err) {
      console.error("Failed to delete Telegram webhook:", err);
      // Continue — the account state is still updated
    }
  }

  // If enabling, re-register the webhook
  if (enabled === true) {
    try {
      await registerWebhook(account.encryptedToken, account.id, account.webhookSecret);
    } catch (err) {
      console.error("Failed to register Telegram webhook:", err);
    }
  }

  const data: { enabled?: boolean; notifyChatId?: bigint | null } = {};
  if (enabled !== undefined) data.enabled = enabled;
  if (notifyChatId !== undefined) {
    try {
      data.notifyChatId = await parseNotifyChatId(account.id, notifyChatId);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Invalid notifyChatId" },
        { status: 400 },
      );
    }
  }

  const updated = await prisma.telegramAccount.update({
    where: { id: account.id },
    data,
    select: {
      id: true,
      enabled: true,
      botId: true,
      botUsername: true,
      notifyChatId: true,
      updatedAt: true,
    },
  });

  const notifyChat = await resolveNotifyChat(updated.id, updated.notifyChatId);

  return NextResponse.json({
    account: {
      id: updated.id,
      enabled: updated.enabled,
      botId: updated.botId?.toString() ?? null,
      botUsername: updated.botUsername,
      notifyChatId: updated.notifyChatId?.toString() ?? null,
      notifyChat: notifyChat
        ? {
            chatId: notifyChat.chatId.toString(),
            label: notifyChat.label,
            source: notifyChat.source,
          }
        : null,
      updatedAt: updated.updatedAt.toISOString(),
    },
  });
}

/**
 * DELETE /api/integrations/telegram — Remove Telegram integration
 */
export async function DELETE() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const account = await prisma.telegramAccount.findUnique({
    where: { userId: authResult.user.id },
  });

  if (!account) {
    return NextResponse.json({ error: "No Telegram integration found" }, { status: 404 });
  }

  // Delete the webhook first
  try {
    await deleteWebhook(account.encryptedToken);
  } catch (err) {
    console.error("Failed to delete Telegram webhook during removal:", err);
    // Continue — the account will still be deleted
  }

  // Delete the account (cascade deletes whitelist and chats)
  await prisma.telegramAccount.delete({
    where: { id: account.id },
  });

  return NextResponse.json({ success: true });
}
