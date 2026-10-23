import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { listChatPorts, SandboxUnavailableError } from "@/lib/coder/ports";
import { TerminalNotReadyError } from "@/lib/coder/terminal";
import { SandboxApiError } from "@/lib/sandbox/client";
import { previewConfig } from "@/lib/preview/url";

/**
 * GET /api/coder/sessions/:id/ports. What the chat's worktree is listening on,
 * and the preview URL for each port.
 *
 * A chat whose worktree does not exist yet answers with an empty list: the panel
 * is open, there is just nothing running until the first message builds it.
 */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { sessionId } = await context.params;

  try {
    const result = await listChatPorts(authResult.user.id, sessionId);
    if (!result) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof TerminalNotReadyError) {
      const { domain } = previewConfig();
      return NextResponse.json({ enabled: domain !== null, domain, ports: [] });
    }
    if (err instanceof SandboxUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    if (err instanceof SandboxApiError) {
      console.error(`Failed to list ports for ${sessionId}:`, err);
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    console.error(`Failed to list ports for ${sessionId}:`, err);
    return NextResponse.json({ error: "Could not read the workspace" }, { status: 500 });
  }
}
