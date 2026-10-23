import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { assertRepoRelativePath, loadSessionDiff } from "@/lib/coder/changes";
import { GitError } from "@/lib/coder/git";

/**
 * GET /api/coder/sessions/:id/diff?path=&staged=
 *
 * One file's unified diff. The path is repo-relative and re-checked here, so a
 * crafted path cannot walk out of the worktree.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { sessionId } = await context.params;
  const params = request.nextUrl.searchParams;
  const rawPath = params.get("path");

  if (!rawPath) return NextResponse.json({ error: "path is required" }, { status: 400 });

  let path: string;
  try {
    path = assertRepoRelativePath(rawPath);
  } catch (err) {
    console.error(`Rejected coder diff path "${rawPath}":`, err);
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  try {
    const diff = await loadSessionDiff(authResult.user.id, sessionId, {
      path,
      staged: params.get("staged") === "1",
    });
    if (diff === null) {
      return NextResponse.json({ error: "No worktree for this chat" }, { status: 404 });
    }
    return NextResponse.json({ diff });
  } catch (err) {
    if (err instanceof GitError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    console.error(`Failed to read coder diff for ${sessionId}:`, err);
    return NextResponse.json({ error: "Could not read the diff" }, { status: 500 });
  }
}
