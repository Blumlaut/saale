import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getPendingPluginUiRequestsForUser, toPluginUiPayload } from "@/lib/plugin-ui/requests";

/**
 * GET /api/plugin-ui/pending. the dialogs waiting on this user, any chat.
 *
 * The chat's own stream carries the dialog for the chat that is open; this is
 * how the rest of the app knows one is waiting somewhere, so the sidebar can
 * point at it instead of the user finding it by accident.
 */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const userId = session.user.id;
  const chats = await getPendingPluginUiRequestsForUser(userId);

  return NextResponse.json({
    pending: chats.map((entry) => ({
      sessionId: entry.sessionId,
      dialog: toPluginUiPayload(entry.request),
    })),
  });
}
