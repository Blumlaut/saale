import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { loadSharedChat } from "@/lib/chat/share";

/**
 * GET /api/chat/sessions/share/:token/messages. The JSON a share page renders.
 *
 * A public chat answers anyone holding the token. A chat shared with signed-in
 * users only answers a caller with a session, and says nothing about itself to
 * the others. Tool calls are redacted inside `loadSharedChat`: see
 * `@/lib/chat/redact-tool-calls`.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const session = await getSession();
  const shared = await loadSharedChat(token, session?.user?.id ?? null);

  if (shared.state === "not-found") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (shared.state === "needs-auth") {
    return NextResponse.json({ error: "Sign in to view this chat" }, { status: 401 });
  }

  return NextResponse.json({
    session: {
      id: shared.session.id,
      title: shared.session.title,
      createdAt: shared.session.createdAt.toISOString(),
    },
    messages: shared.messages,
  });
}
