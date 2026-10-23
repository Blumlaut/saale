import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { stopTerminalRun } from "@/lib/coder/terminal-runs";

/**
 * POST /api/coder/sessions/:id/terminal/stop. stop the chat's running command.
 *
 * The panel is not the only reason a command exists, so this is an endpoint
 * rather than a dropped connection. The exit reaches every reader the same way
 * as one the command produced itself.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { sessionId } = await params;
  const stopped = await stopTerminalRun(authResult.user.id, sessionId);
  return NextResponse.json({ stopped });
}
