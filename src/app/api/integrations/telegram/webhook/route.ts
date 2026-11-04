import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getTelegramBot } from "@/lib/telegram/bot";
import { handleTelegramUpdate } from "@/lib/telegram/updates";

/**
 * POST /api/integrations/telegram/webhook
 *
 * Receives Telegram updates for the instance's shared bot.
 *
 * The secret in Telegram's `X-Telegram-Bot-Api-Secret-Token` header is what
 * proves a delivery comes from Telegram, so it is checked here and nowhere
 * else. An instance Telegram cannot reach is polled for updates instead, and
 * those arrive already authenticated (see `polling.ts`).
 */
export async function POST(request: NextRequest) {
  // 1. The instance's bot must exist and be switched on
  const botConfig = await getTelegramBot();

  if (!botConfig) {
    return NextResponse.json({ error: "Telegram is not configured" }, { status: 404 });
  }

  if (!botConfig.enabled) {
    return NextResponse.json({ error: "Telegram integration is disabled" }, { status: 403 });
  }

  // 2. Verify the webhook secret (Telegram sends this in a header)
  const incomingSecret = request.headers.get("x-telegram-bot-api-secret-token");
  if (incomingSecret !== botConfig.webhookSecret) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // 3. Parse the update
  let update: unknown;
  try {
    update = await request.json();
  } catch (err) {
    console.error("Failed to parse Telegram update body:", err);
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // 4. Handle it. A message is processed in the background, so this answers
  //    Telegram immediately rather than holding the delivery open.
  await handleTelegramUpdate(update, botConfig);

  return NextResponse.json({ ok: true });
}
