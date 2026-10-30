import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireChatSessionOwner } from "@/lib/auth";
import { promptPickerItemsForChat } from "@/lib/prompts/chat";

/**
 * GET /api/chat/sessions/:sessionId/prompts. The prompts this chat offers, the
 * user's own plus the ones in its checkout's `.pi/prompts`, which the composer
 * lists under its `/` menu.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  const authResult = await requireChatSessionOwner(sessionId);
  if (!authResult.ok) return authResult.response;

  const prompts = await promptPickerItemsForChat(authResult.userId, authResult.session);
  return NextResponse.json({ prompts });
}
