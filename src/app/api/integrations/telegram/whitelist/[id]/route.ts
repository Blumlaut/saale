import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * DELETE /api/integrations/telegram/whitelist/:id — Remove a whitelisted user
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { id } = await params;

  // Verify the whitelist entry belongs to the authenticated user's Telegram account
  const entry = await prisma.telegramWhitelist.findFirst({
    where: {
      id,
      account: { userId: authResult.user.id },
    },
    select: { id: true },
  });

  if (!entry) {
    return NextResponse.json({ error: "Whitelist entry not found" }, { status: 404 });
  }

  await prisma.telegramWhitelist.delete({
    where: { id },
  });

  return NextResponse.json({ success: true });
}
