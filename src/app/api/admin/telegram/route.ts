import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/app/api/admin/settings/auth";
import {
  getTelegramBot,
  removeTelegramBot,
  saveTelegramBot,
  setTelegramBotEnabled,
  type TelegramBotConfig,
} from "@/lib/telegram/bot";

/**
 * The shared Telegram bot's configuration.
 *
 * Admin-scoped: the bot is instance infrastructure now, so its token is only
 * reachable here. The token is never echoed back — responses carry the bot's
 * identity and state, which is all the UI needs to render.
 */

/** Serialize the bot for the admin UI. Never includes the token. */
async function serializeBot(bot: TelegramBotConfig | null) {
  if (!bot) return { configured: false as const };

  const linkCount = await prisma.telegramLink.count({ where: { botId: bot.id } });

  return {
    configured: true as const,
    enabled: bot.enabled,
    botId: bot.botId?.toString() ?? null,
    botUsername: bot.botUsername,
    linkCount,
    updatedByUserId: bot.updatedByUserId,
    updatedAt: bot.updatedAt.toISOString(),
  };
}

/**
 * GET /api/admin/telegram — the bot's current configuration and reach.
 */
export async function GET() {
  const authResult = await requireAdmin();
  if (!authResult.ok) return authResult.response;

  const bot = await getTelegramBot();
  return NextResponse.json({ bot: await serializeBot(bot) });
}

/**
 * POST /api/admin/telegram — save a bot token.
 * Body: { token: string }
 */
export async function POST(request: NextRequest) {
  const authResult = await requireAdmin();
  if (!authResult.ok) return authResult.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch (err) {
    console.error("Failed to parse the Telegram bot token body:", err);
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const token = (body as { token?: unknown } | null)?.token;
  if (typeof token !== "string" || token.trim().length < 10) {
    return NextResponse.json({ error: "Invalid bot token" }, { status: 400 });
  }

  try {
    const { bot, webhookRegistered } = await saveTelegramBot({
      token: token.trim(),
      adminUserId: authResult.user.id,
    });

    return NextResponse.json({
      bot: await serializeBot(bot),
      webhookRegistered,
    });
  } catch (err) {
    // getMe() rejecting means the token is wrong — that is the admin's input,
    // not a server fault.
    const message = err instanceof Error ? err.message : "Failed to validate the bot token";
    console.error("Failed to save the shared Telegram bot:", err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/**
 * PATCH /api/admin/telegram — switch the bot on or off.
 * Body: { enabled: boolean }
 */
export async function PATCH(request: NextRequest) {
  const authResult = await requireAdmin();
  if (!authResult.ok) return authResult.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch (err) {
    console.error("Failed to parse the Telegram bot toggle body:", err);
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const enabled = (body as { enabled?: unknown } | null)?.enabled;
  if (typeof enabled !== "boolean") {
    return NextResponse.json({ error: "Missing 'enabled' field" }, { status: 400 });
  }

  const existing = await getTelegramBot();
  if (!existing) {
    return NextResponse.json({ error: "No Telegram bot is configured" }, { status: 404 });
  }

  const bot = await setTelegramBotEnabled(enabled);
  return NextResponse.json({ bot: await serializeBot(bot) });
}

/**
 * DELETE /api/admin/telegram — remove the bot and every link.
 */
export async function DELETE() {
  const authResult = await requireAdmin();
  if (!authResult.ok) return authResult.response;

  const removed = await removeTelegramBot();
  if (!removed) {
    return NextResponse.json({ error: "No Telegram bot is configured" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
