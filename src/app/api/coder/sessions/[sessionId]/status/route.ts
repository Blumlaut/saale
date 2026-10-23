import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { loadSessionState } from "@/lib/coder/changes";
import { GitError } from "@/lib/coder/git";

/**
 * GET /api/coder/sessions/:id/status. The worktree's branch, changes and recent
 * commits, for the right-hand panel.
 *
 * A chat whose worktree does not exist yet answers with `worktree: null` rather
 * than a 404: the panel is open, there is just nothing in it until the first
 * message builds the worktree.
 */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { sessionId } = await context.params;

  try {
    const state = await loadSessionState(authResult.user.id, sessionId);
    if (!state) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    return NextResponse.json(state);
  } catch (err) {
    if (err instanceof GitError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    console.error(`Failed to read coder status for ${sessionId}:`, err);
    return NextResponse.json({ error: "Could not read the worktree" }, { status: 500 });
  }
}
