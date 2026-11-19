import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import {
  closeShell,
  ShellUnavailableError,
  shellAvailability,
  startShell,
} from "@/lib/terminal/shell-sessions";

/**
 * POST /api/terminal?target=. open a shell on a workspace.
 *
 * The target is the token the file browser already uses: `user` for the user's
 * own workspace, `machine:<id>` for one of their servers. Opening the same
 * target twice hands back the shell that is already there, so a page that
 * remounts does not start a second one.
 *
 * GET /api/terminal/stream is how a reader follows it, and DELETE is how it
 * ends.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  try {
    const shell = await startShell(authResult.user.id, targetOf(request));
    return NextResponse.json({ shell });
  } catch (err) {
    if (err instanceof ShellUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("Failed to open a shell:", err);
    return NextResponse.json({ error: "Could not open the terminal" }, { status: 500 });
  }
}

/** GET /api/terminal?target=. whether this workspace can have a shell at all. */
export async function GET(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  try {
    return NextResponse.json(await shellAvailability(authResult.user.id, targetOf(request)));
  } catch (err) {
    console.error("Failed to check the terminal's availability:", err);
    return NextResponse.json({ error: "Could not check the terminal" }, { status: 500 });
  }
}

/** DELETE /api/terminal?target=. close the shell, whatever it is running. */
export async function DELETE(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  return NextResponse.json({ closed: closeShell(authResult.user.id, targetOf(request)) });
}

/** The workspace this request is about. */
function targetOf(request: NextRequest): string {
  return request.nextUrl.searchParams.get("target") ?? "";
}
