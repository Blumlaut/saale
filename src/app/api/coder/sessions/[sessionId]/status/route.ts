import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { DEFAULT_COMMIT_LIMIT, loadSessionState, MAX_COMMIT_LIMIT } from "@/lib/coder/changes";
import { GitError } from "@/lib/coder/git";
import { getProvisioning } from "@/lib/coder/provisioning";
import { getSetupFailure } from "@/lib/coder/setup-failure";

/**
 * GET /api/coder/sessions/:id/status. The worktree's branch, changes and recent
 * commits, for the right-hand panel.
 *
 * A chat whose worktree does not exist yet answers with `worktree: null` rather
 * than a 404: the panel is open, there is just nothing in it until the first
 * message builds the worktree. `provisioning` says whether that build is
 * happening right now, so the panel shows the work instead of an empty box, and
 * `setupFailure` says a build finished with its install broken.
 *
 * `?commits=` is how far back the history goes, so the panel can ask for more
 * without a second endpoint.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { sessionId } = await context.params;
  const requested = Number(request.nextUrl.searchParams.get("commits") ?? DEFAULT_COMMIT_LIMIT);
  const commitLimit = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), MAX_COMMIT_LIMIT)
    : DEFAULT_COMMIT_LIMIT;

  try {
    const state = await loadSessionState(authResult.user.id, sessionId, { commitLimit });
    if (!state) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    const [provisioning, setupFailure] = await Promise.all([
      getProvisioning(sessionId),
      getSetupFailure(sessionId),
    ]);
    return NextResponse.json({ ...state, provisioning, setupFailure });
  } catch (err) {
    if (err instanceof GitError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    console.error(`Failed to read coder status for ${sessionId}:`, err);
    return NextResponse.json({ error: "Could not read the worktree" }, { status: 500 });
  }
}
