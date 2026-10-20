import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireChatSessionOwner } from "@/lib/auth";
import { executeCommand } from "@/lib/commands/execute";

/**
 * POST /api/chat/sessions/:sessionId/command. run a slash command.
 *
 * The web chat's only command entrypoint: the composer intercepts a leading
 * `/name`, posts it here, and renders whatever comes back. a prompt (the
 * command needs a choice) or an outcome. Telegram reaches the same
 * `executeCommand` through its own adapter, so a command is implemented once.
 *
 * Body: `{ name: string, args?: string, value?: string }`
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  const authResult = await requireChatSessionOwner(sessionId);
  if (!authResult.ok) return authResult.response;

  let body: { name?: unknown; args?: unknown; value?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.name !== "string" || !body.name) {
    return NextResponse.json({ error: "A command name is required" }, { status: 400 });
  }
  if (body.args !== undefined && typeof body.args !== "string") {
    return NextResponse.json({ error: "args must be a string" }, { status: 400 });
  }
  if (body.value !== undefined && typeof body.value !== "string") {
    return NextResponse.json({ error: "value must be a string" }, { status: 400 });
  }

  const result = await executeCommand(
    body.name,
    {
      surface: "web",
      userId: authResult.userId,
      sessionId,
      args: body.args ?? "",
    },
    body.value,
  );

  if (result.kind === "error") {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json(result);
}
