import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireChatSessionOwner } from "@/lib/auth";
import { stopChatGeneration } from "@/lib/chat/stop-generation";

/**
 * POST /api/chat/sessions/:sessionId/stop — explicitly cancel an in-progress
 * generation.
 *
 * Different from client disconnect (navigation/refresh) — this is a
 * user-initiated "stop" that aborts the LLM, clears the active session flag
 * immediately, and pauses the send queue until the user sends or pushes
 * something. The work lives in `stopChatGeneration` so the `/stop` slash
 * command stops a run exactly the same way.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  const authResult = await requireChatSessionOwner(sessionId);
  if (!authResult.ok) return authResult.response;

  await stopChatGeneration(authResult.userId, sessionId);
  return NextResponse.json({ stopped: true });
}
