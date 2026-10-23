import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { removeTelegramChat } from "@/lib/telegram/chats";

/**
 * DELETE /api/integrations/telegram/chats/:chatId. remove a group.
 *
 * The row is scoped to the caller, so an id belonging to another account is
 * simply not found. The bot leaves the group as part of the removal.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ chatId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { chatId } = await params;
  if (!/^-?\d+$/.test(chatId)) {
    return NextResponse.json({ error: "Not a Telegram chat id" }, { status: 400 });
  }

  const removed = await removeTelegramChat({
    ownerUserId: authResult.user.id,
    chatId: BigInt(chatId),
  });

  if (!removed) {
    return NextResponse.json({ error: "No such group" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
