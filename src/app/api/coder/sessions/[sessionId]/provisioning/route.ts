import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireChatSessionOwner } from "@/lib/auth";
import { getProvisioning } from "@/lib/coder/provisioning";

/**
 * GET /api/coder/sessions/:id/provisioning. whether this chat is building its
 * workspace right now, and which step it is on.
 *
 * Split from `/status`: that one asks git, so it cannot be polled once a
 * second, and the chat does exactly that while it waits for its first reply.
 */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await context.params;

  // Ownership, not just a session: the record is keyed by chat id, and a chat
  // id alone must never be enough to read another user's state.
  const authResult = await requireChatSessionOwner(sessionId);
  if (!authResult.ok) return authResult.response;

  return NextResponse.json({ provisioning: await getProvisioning(sessionId) });
}
