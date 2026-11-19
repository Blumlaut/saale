import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBody } from "@/lib/api-body";
import { requireSession } from "@/lib/auth";
import { MAX_SHELL_DIMENSION, resizeShell } from "@/lib/terminal/shell-sessions";

/**
 * POST /api/terminal/resize?target=. tell a shell how big its terminal became.
 *
 * A full-screen program (an editor, a monitor) draws to the size it is told, so
 * a panel that was widened says so rather than leaving the program drawing for
 * the old one.
 */

const resizeSchema = z.object({
  cols: z.number().int().min(1).max(MAX_SHELL_DIMENSION),
  rows: z.number().int().min(1).max(MAX_SHELL_DIMENSION),
});

export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await readJsonBody(request, resizeSchema);
  if (!body.ok) return body.response;

  const target = request.nextUrl.searchParams.get("target") ?? "";
  const resized = resizeShell(authResult.user.id, target, body.data.cols, body.data.rows);
  if (!resized) {
    return NextResponse.json({ error: "The terminal is not running" }, { status: 409 });
  }
  return NextResponse.json({ cols: body.data.cols, rows: body.data.rows });
}
