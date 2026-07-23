import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireChatSessionOwner } from "@/lib/auth";
import { resolveApproval } from "@/lib/pi/tool-approval-gate";

/**
 * POST /api/chat/sessions/:sessionId/approve-tool
 *
 * Approve or deny a pending tool call.
 *
 * Body: { toolCallId: string, approved: boolean }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  const authResult = await requireChatSessionOwner(sessionId);
  if (!authResult.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { toolCallId?: string; approved?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.toolCallId || typeof body.approved !== "boolean") {
    return NextResponse.json({ error: "Missing toolCallId or approved field" }, { status: 400 });
  }

  const resolved = await resolveApproval(sessionId, body.toolCallId, body.approved);

  if (!resolved) {
    return NextResponse.json(
      { error: "Approval request not found or already resolved" },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true });
}
