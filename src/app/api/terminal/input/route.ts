import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBody } from "@/lib/api-body";
import { requireSession } from "@/lib/auth";
import { sendShellInput } from "@/lib/terminal/shell-sessions";

/**
 * POST /api/terminal/input?target=. type into a shell.
 *
 * Keystrokes, not lines: an arrow key or a ctrl-c is as much input as Enter, so
 * the body carries whatever the terminal collected since the last write.
 */

const inputSchema = z.object({ data: z.string().max(64 * 1024) });

export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await readJsonBody(request, inputSchema);
  if (!body.ok) return body.response;

  const target = request.nextUrl.searchParams.get("target") ?? "";
  const written = sendShellInput(authResult.user.id, target, body.data.data);
  if (!written) {
    return NextResponse.json({ error: "The terminal is not running" }, { status: 409 });
  }
  return NextResponse.json({ written: body.data.data.length });
}
