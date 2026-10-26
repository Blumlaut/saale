import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireChatSessionOwner } from "@/lib/auth";
import { resolvePluginUiRequest, type PluginUiResponse } from "@/lib/plugin-ui/requests";

/**
 * POST /api/chat/sessions/:sessionId/plugin-ui. answer a plugin's dialog.
 *
 * Body: `{ id, value?, confirmed?, cancelled? }`. The dialog method decides
 * which field it reads, so the body is validated per kind by the plugin side;
 * here it only has to be one of the three.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  const authResult = await requireChatSessionOwner(sessionId);
  if (!authResult.ok) return authResult.response;

  let body: { id?: unknown; value?: unknown; confirmed?: unknown; cancelled?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.id !== "string" || !body.id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  const response: PluginUiResponse = {};
  if (typeof body.value === "string") response.value = body.value;
  if (typeof body.confirmed === "boolean") response.confirmed = body.confirmed;
  if (body.cancelled === true) response.cancelled = true;

  if (response.value === undefined && response.confirmed === undefined && !response.cancelled) {
    return NextResponse.json({ error: "Nothing to answer with" }, { status: 400 });
  }

  const resolved = await resolvePluginUiRequest(sessionId, body.id, response);
  if (!resolved) {
    return NextResponse.json({ error: "Dialog not found or already answered" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
