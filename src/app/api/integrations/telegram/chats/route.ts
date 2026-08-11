import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getDefaultTelegramChatInfo, listTelegramChats } from "@/lib/telegram/chats";

/**
 * GET /api/integrations/telegram/chats — List the user's Telegram chats
 *
 * Returns the chats the bot has been active in (most recent first) plus the
 * resolved "configured chat" that agent jobs inherit when no explicit chat
 * ID is set. Used by the agent job dialog to offer chat ID inheritance
 * instead of requiring manual entry.
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const account = await prisma.telegramAccount.findUnique({
    where: { userId: authResult.user.id },
    select: { id: true },
  });

  if (!account) {
    return NextResponse.json({ chats: [], defaultChat: null });
  }

  const [chats, defaultChat] = await Promise.all([
    listTelegramChats(account.id),
    getDefaultTelegramChatInfo(account.id),
  ]);

  return NextResponse.json({ chats, defaultChat });
}
