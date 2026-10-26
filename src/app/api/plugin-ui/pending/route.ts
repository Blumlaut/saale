import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSession, requireChatSessionOwner } from "@/lib/auth";
import {
  getPendingPluginUiRequests,
  getPendingPluginUiRequestsForUser,
  toPluginUiPayload,
} from "@/lib/plugin-ui/requests";

/**
 * GET /api/plugin-ui/pending. the dialogs still waiting for this user.
 *
 * `?sessionId=` keeps the read to that chat's keys, which is what an open chat
 * polls: the run is blocked until the dialog is answered, so it has to survive a
 * reload or a reconnect. Without it the answer covers every chat the user has,
 * for a client that points at the chat holding one.
 */
export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("sessionId");

  if (sessionId) {
    const authResult = await requireChatSessionOwner(sessionId);
    if (!authResult.ok) return authResult.response;

    const requests = await getPendingPluginUiRequests(sessionId);
    return NextResponse.json({
      pending: requests.map((dialog) => ({ sessionId, dialog: toPluginUiPayload(dialog) })),
    });
  }

  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const chats = await getPendingPluginUiRequestsForUser(session.user.id);

  return NextResponse.json({
    pending: chats.map((entry) => ({
      sessionId: entry.sessionId,
      dialog: toPluginUiPayload(entry.request),
    })),
  });
}
