import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { validateBotToken, registerWebhook, deleteWebhook } from "@/lib/telegram";
import crypto from "crypto";

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

  return NextResponse.json({
    account: {
      id: account.id,
      enabled: account.enabled,
      botId: account.botId,
      botUsername: account.botUsername,
      whitelistCount: account._count.whitelistedUsers,
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
        botId: account.botId,
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
 * PATCH /api/integrations/telegram — Update Telegram integration (enable/disable)
 * Body: { enabled: boolean }
 */
export async function PATCH(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const enabled = body.enabled as boolean | undefined;

  if (enabled === undefined) {
    return NextResponse.json({ error: "Missing 'enabled' field" }, { status: 400 });
  }

  const account = await prisma.telegramAccount.findUnique({
    where: { userId: authResult.user.id },
  });

  if (!account) {
    return NextResponse.json({ error: "No Telegram integration found" }, { status: 404 });
  }

  // If disabling, remove the webhook
  if (!enabled) {
    try {
      await deleteWebhook(account.encryptedToken);
    } catch (err) {
      console.error("Failed to delete Telegram webhook:", err);
      // Continue — the account state is still updated
    }
  }

  // If enabling, re-register the webhook
  if (enabled) {
    try {
      await registerWebhook(account.encryptedToken, account.id, account.webhookSecret);
    } catch (err) {
      console.error("Failed to register Telegram webhook:", err);
    }
  }

  const updated = await prisma.telegramAccount.update({
    where: { id: account.id },
    data: { enabled },
    select: {
      id: true,
      enabled: true,
      botId: true,
      botUsername: true,
      updatedAt: true,
    },
  });

  return NextResponse.json({
    account: {
      id: updated.id,
      enabled: updated.enabled,
      botId: updated.botId,
      botUsername: updated.botUsername,
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
