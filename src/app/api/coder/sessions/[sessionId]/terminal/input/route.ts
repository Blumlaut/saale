import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { SandboxApiError } from "@/lib/sandbox/client";
import { sendTerminalInput, TerminalNotReadyError } from "@/lib/coder/terminal";

/**
 * POST /api/coder/sessions/:id/terminal/input. type into a running command.
 *
 * Keystrokes, not lines: an arrow key or a ctrl-c is as much input as Enter, so
 * the body carries whatever the panel collected since the last flush.
 */

const inputSchema = z.object({
  execId: z.string().min(1).max(128),
  data: z.string().max(64 * 1024),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { sessionId } = await params;

  const body = await request.json().catch((err: unknown) => {
    console.error("Unreadable terminal input body:", err);
    return null;
  });
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Expected { execId, data }" }, { status: 400 });
  }

  try {
    await sendTerminalInput({
      userId: authResult.user.id,
      sessionId,
      execId: parsed.data.execId,
      data: parsed.data.data,
    });
    return NextResponse.json({ written: parsed.data.data.length });
  } catch (err) {
    if (err instanceof TerminalNotReadyError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof SandboxApiError && err.status === 404) {
      return NextResponse.json({ error: "That command is no longer running" }, { status: 409 });
    }
    console.error(`Failed to write to the terminal for chat ${sessionId}:`, err);
    return NextResponse.json({ error: "Could not reach the terminal" }, { status: 502 });
  }
}
