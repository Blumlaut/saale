import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { MAX_TERMINAL_DIMENSION, resizeTerminalRun } from "@/lib/coder/terminal-runs";

/**
 * POST /api/coder/sessions/:id/terminal/resize. tell the run how big the panel is.
 *
 * A full-screen program draws to the size it was told, so the panel sends its
 * own whenever it changes. Nothing is running is not an error: the size is kept
 * for the next command.
 */

const sizeSchema = z.object({
  cols: z.number().int().min(1).max(MAX_TERMINAL_DIMENSION),
  rows: z.number().int().min(1).max(MAX_TERMINAL_DIMENSION),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { sessionId } = await params;

  const body = await request.json().catch((err: unknown) => {
    console.error("Unreadable terminal resize body:", err);
    return null;
  });
  const parsed = sizeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: `Expected { cols, rows } up to ${MAX_TERMINAL_DIMENSION}` },
      { status: 400 },
    );
  }

  try {
    const resized = await resizeTerminalRun(
      authResult.user.id,
      sessionId,
      parsed.data.cols,
      parsed.data.rows,
    );
    return NextResponse.json({ resized });
  } catch (err) {
    console.error(`Failed to resize the terminal for chat ${sessionId}:`, err);
    return NextResponse.json({ error: "Could not resize the terminal" }, { status: 502 });
  }
}
