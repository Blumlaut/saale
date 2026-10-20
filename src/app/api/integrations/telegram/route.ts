import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getTelegramBot } from "@/lib/telegram/bot";
import { issueLinkCode, unlinkUser, getLinkByUserId } from "@/lib/telegram/links";
import { getTelegramLoginStatus } from "@/lib/telegram/oidc";

/**
 * Build the `t.me` deep link that opens the shared bot with the payload that
 * redeems a link code.
 */
function buildDeepLink(botUsername: string, code: string): string {
  return `https://t.me/${botUsername}?start=${code}`;
}

/**
 * GET /api/integrations/telegram. this user's Telegram status.
 *
 * The bot token is deliberately absent: it is instance infrastructure now, and
 * only the admin route can read it.
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const [bot, link, login] = await Promise.all([
    getTelegramBot(),
    getLinkByUserId(authResult.user.id),
    // Whether this user can also sign in with the account they linked.
    getTelegramLoginStatus(),
  ]);

  return NextResponse.json({
    integration: {
      bot: {
        configured: bot !== null,
        enabled: bot?.enabled ?? false,
        username: bot?.botUsername ?? null,
        loginEnabled: login.enabled,
      },
      link: link
        ? {
            telegramUserId: link.telegramUserId.toString(),
            chatId: link.telegramChatId.toString(),
            displayName: link.displayName,
            linkedAt: link.createdAt.toISOString(),
          }
        : null,
    },
  });
}

/**
 * POST /api/integrations/telegram. start linking this account.
 *
 * Returns a one-time code plus a deep link that redeems it. The code is bound
 * to the caller, so sending it to the bot can only ever link *their* Telegram
 * account to *their* Saale account.
 */
export async function POST(_request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const bot = await getTelegramBot();
  if (!bot) {
    return NextResponse.json(
      { error: "No Telegram bot is set up on this instance yet. Ask an admin to configure one." },
      { status: 409 },
    );
  }

  if (!bot.enabled) {
    return NextResponse.json(
      { error: "The Telegram bot is switched off. Ask an admin to enable it." },
      { status: 409 },
    );
  }

  if (!bot.botUsername) {
    return NextResponse.json(
      {
        error:
          "The Telegram bot has no username, so it cannot be opened. Ask an admin to re-save it.",
      },
      { status: 409 },
    );
  }

  const { code, expiresAt } = await issueLinkCode(authResult.user.id);

  return NextResponse.json({
    code,
    deepLink: buildDeepLink(bot.botUsername, code),
    expiresAt: expiresAt.toISOString(),
    botUsername: bot.botUsername,
  });
}

/**
 * DELETE /api/integrations/telegram. unlink this account.
 *
 * Nothing is sent to Telegram, so the link disappears silently; the user can
 * relink at any time with a fresh code.
 */
export async function DELETE() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const removed = await unlinkUser(authResult.user.id);

  if (!removed) {
    return NextResponse.json({ error: "No linked Telegram account found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
