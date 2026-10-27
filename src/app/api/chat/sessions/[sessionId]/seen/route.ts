import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireChatSessionOwner } from "@/lib/auth";
import { markChatSeen } from "@/lib/redis";

/**
 * POST /api/chat/sessions/:sessionId/seen. the chat is on screen right now, so
 * a reply that lands here should not be pushed to the user's other devices.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  const authResult = await requireChatSessionOwner(sessionId);
  if (!authResult.ok) return authResult.response;

  await markChatSeen(authResult.userId, sessionId);

  return new NextResponse(null, { status: 204 });
}
