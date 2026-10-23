import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { killChatPort, SandboxUnavailableError, UnknownChatPortError } from "@/lib/coder/ports";
import { TerminalNotReadyError } from "@/lib/coder/terminal";
import { SandboxApiError } from "@/lib/sandbox/client";

/**
 * POST /api/coder/sessions/:id/ports/:port/kill. Stop the process listening on
 * one of the chat's ports.
 */
export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ sessionId: string; port: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { sessionId, port: rawPort } = await context.params;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return NextResponse.json({ error: "Not a port" }, { status: 400 });
  }

  try {
    const result = await killChatPort(authResult.user.id, sessionId, port);
    if (!result) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof UnknownChatPortError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof TerminalNotReadyError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof SandboxUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    if (err instanceof SandboxApiError) {
      console.error(`Failed to stop port ${port} for ${sessionId}:`, err);
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    console.error(`Failed to stop port ${port} for ${sessionId}:`, err);
    return NextResponse.json({ error: "Could not stop that server" }, { status: 500 });
  }
}
