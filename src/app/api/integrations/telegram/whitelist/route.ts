import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * GET /api/integrations/telegram/whitelist — List whitelisted users
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const account = await prisma.telegramAccount.findUnique({
    where: { userId: authResult.user.id },
    select: { id: true },
  });

  if (!account) {
    return NextResponse.json({ error: "No Telegram integration found" }, { status: 404 });
  }

  const entries = await prisma.telegramWhitelist.findMany({
    where: { telegramAccountId: account.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      telegramUserId: true,
      displayName: true,
      createdAt: true,
    },
  });

  return NextResponse.json({
    entries: entries.map((e) => ({
      id: e.id,
      telegramUserId: e.telegramUserId.toString(),
      displayName: e.displayName,
      createdAt: e.createdAt.toISOString(),
    })),
  });
}

/**
 * POST /api/integrations/telegram/whitelist — Add a user to the whitelist
 * Body: { telegramUserId: string }
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const telegramUserIdStr = body.telegramUserId as string | undefined;

  if (!telegramUserIdStr || typeof telegramUserIdStr !== "string") {
    return NextResponse.json(
      { error: "Missing or invalid 'telegramUserId' (must be a string)" },
      { status: 400 },
    );
  }

  // Parse as BigInt (Telegram user IDs can exceed Number.MAX_SAFE_INTEGER)
  let telegramUserId: bigint;
  try {
    telegramUserId = BigInt(telegramUserIdStr);
  } catch {
    return NextResponse.json(
      { error: "Invalid Telegram user ID (must be a number)" },
      { status: 400 },
    );
  }

  const account = await prisma.telegramAccount.findUnique({
    where: { userId: authResult.user.id },
    select: { id: true },
  });

  if (!account) {
    return NextResponse.json({ error: "No Telegram integration found" }, { status: 404 });
  }

  const entry = await prisma.telegramWhitelist.create({
    data: {
      telegramAccountId: account.id,
      telegramUserId,
    },
    select: {
      id: true,
      telegramUserId: true,
      displayName: true,
      createdAt: true,
    },
  });

  return NextResponse.json({
    entry: {
      id: entry.id,
      telegramUserId: entry.telegramUserId.toString(),
      displayName: entry.displayName,
      createdAt: entry.createdAt.toISOString(),
    },
  });
}
