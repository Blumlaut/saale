import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import {
  MAX_TERMINAL_COMMAND_LENGTH,
  resolveTerminalTarget,
  TerminalNotReadyError,
} from "@/lib/coder/terminal";
import {
  beginTerminalRun,
  clearTerminalRun,
  MAX_TERMINAL_DIMENSION,
  TerminalBusyError,
} from "@/lib/coder/terminal-runs";

/**
 * POST /api/coder/sessions/:id/terminal. start a command in the chat's worktree.
 *
 * The command belongs to the chat: it keeps running after this answer, while
 * the panel is closed and while another chat is open. GET /terminal/stream is
 * how a reader watches it, and POST /terminal/stop is how it ends early.
 */

const commandSchema = z.object({
  // Only the command: the directory is the chat's worktree, resolved here.
  command: z.string().min(1).max(MAX_TERMINAL_COMMAND_LENGTH),
  // The panel's own size, so a full-screen program draws to it.
  cols: z.number().int().min(1).max(MAX_TERMINAL_DIMENSION).optional(),
  rows: z.number().int().min(1).max(MAX_TERMINAL_DIMENSION).optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;
  const userId = authResult.user.id;

  const { sessionId } = await params;

  const body = await request.json().catch((err: unknown) => {
    console.error("Unreadable terminal request body:", err);
    return null;
  });
  const parsed = commandSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: `Expected { command } up to ${MAX_TERMINAL_COMMAND_LENGTH} characters` },
      { status: 400 },
    );
  }

  let target;
  try {
    target = await resolveTerminalTarget(userId, sessionId);
  } catch (err) {
    if (err instanceof TerminalNotReadyError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error(`Failed to resolve the terminal for chat ${sessionId}:`, err);
    return NextResponse.json({ error: "Could not open the worktree" }, { status: 500 });
  }
  if (!target) return NextResponse.json({ error: "Session not found" }, { status: 404 });

  try {
    const run = beginTerminalRun({
      userId,
      sessionId,
      cwd: target.cwd,
      command: parsed.data.command,
      ...(parsed.data.cols ? { cols: parsed.data.cols } : {}),
      ...(parsed.data.rows ? { rows: parsed.data.rows } : {}),
    });
    return NextResponse.json({ run });
  } catch (err) {
    if (err instanceof TerminalBusyError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error(`Failed to start a terminal command in chat ${sessionId}:`, err);
    return NextResponse.json({ error: "Could not start the command" }, { status: 500 });
  }
}

/** DELETE /api/coder/sessions/:id/terminal. throw away what the run printed. */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { sessionId } = await params;
  return NextResponse.json({ cleared: clearTerminalRun(authResult.user.id, sessionId) });
}
