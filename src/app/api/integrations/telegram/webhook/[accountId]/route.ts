import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  processTelegramMessage,
  isWhitelisted,
  upsertWhitelistDisplayName,
} from "@/lib/telegram/processor";
import { createBot } from "@/lib/telegram/client";

/**
 * POST /api/integrations/telegram/webhook/:accountId
 *
 * Receives Telegram updates via webhook. Each user's bot has its own
 * webhook URL pointing to their account ID, so we don't need to
 * disambiguate which bot received the update.
 *
 * Security:
 * - The accountId in the URL is a cuid() (not user-guessable)
 * - The account must exist and be enabled
 * - The webhookSecret is verified via Telegram's X-Telegram-Bot-Api-Secret-Token header
 * - Only whitelisted Telegram users can interact with the bot
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params;

  // 1. Look up the Telegram account (user-isolated via DB query)
  const account = await prisma.telegramAccount.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      userId: true,
      encryptedToken: true,
      enabled: true,
      webhookSecret: true,
    },
  });

  if (!account) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // 2. Check if the integration is enabled
  if (!account.enabled) {
    return NextResponse.json({ error: "Telegram integration is disabled" }, { status: 403 });
  }

  // 3. Verify the webhook secret (Telegram sends this in a header)
  const incomingSecret = request.headers.get("x-telegram-bot-api-secret-token");
  if (incomingSecret !== account.webhookSecret) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // 4. Parse the update
  let update: Record<string, unknown>;
  try {
    update = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // 5. Extract message from update (only handle text messages in private chats)
  const message = update.message as
    | {
        text?: string;
        chat: { id: number; type: string };
        from: { id: number; first_name?: string; last_name?: string };
        message_id: number;
      }
    | undefined;

  if (!message || !message.text || message.chat.type !== "private") {
    // Ignore non-text messages and non-private chats for now
    return NextResponse.json({ ok: true });
  }

  const telegramChatId = BigInt(message.chat.id);
  const telegramUserId = BigInt(message.from.id);

  // 6. Check whitelist
  const whitelisted = await isWhitelisted(account.id, telegramUserId);
  if (!whitelisted) {
    // Send rejection message via direct API call
    const bot = createBot(account.encryptedToken);
    try {
      await bot.api.sendMessage(
        message.chat.id,
        "You are not authorized to use this bot. Contact the owner to get access.",
        {
          parse_mode: "HTML",
        },
      );
    } catch (err) {
      console.error("Failed to send rejection message:", err);
    }
    return NextResponse.json({ ok: true });
  }

  // 7. Update display name cache (fire-and-forget)
  const displayName = [message.from.first_name, message.from.last_name].filter(Boolean).join(" ");
  upsertWhitelistDisplayName(account.id, telegramUserId, displayName || null).catch((err) => {
    console.error("Failed to update whitelist display name:", err);
  });

  // 8. Update last processed message ID (fire-and-forget)
  prisma.telegramChat
    .updateMany({
      where: {
        telegramAccountId: account.id,
        telegramChatId,
      },
      data: { lastMessageId: message.message_id },
    })
    .catch((err) => {
      console.error("Failed to update lastMessageId:", err);
    });

  // 9. Process the message asynchronously
  // Telegram expects a response within 5 seconds, but AI processing takes longer.
  // We return immediately and process in the background.
  processTelegramMessage({
    userId: account.userId,
    encryptedToken: account.encryptedToken,
    telegramChatId,
    telegramUserId,
    messageText: message.text,
    replyToMessageId: message.message_id,
  }).catch((err) => {
    console.error("Telegram message processing failed:", err);
  });

  // 10. Acknowledge receipt immediately
  return NextResponse.json({ ok: true });
}
