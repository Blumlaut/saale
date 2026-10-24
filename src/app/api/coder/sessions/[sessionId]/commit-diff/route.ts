import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { GitError } from "@/lib/coder/git";
import {
  loadCommitDiff,
  loadCommitDiffFile,
  type CommitDiffFileContent,
} from "@/lib/coder/commit-diff";

/**
 * GET /api/coder/sessions/:id/commit-diff?sha=[&path=]
 *
 * A commit's changes for the Diff tab. Without a path it lists the commit's
 * files; with one it answers that path's two sides, for the diff editor. The
 * sha and the path are both re-checked against the repo, so a crafted one
 * cannot read a blob the commit never touched.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { sessionId } = await context.params;
  const params = request.nextUrl.searchParams;
  const sha = params.get("sha");

  if (!sha) return NextResponse.json({ error: "sha is required" }, { status: 400 });

  try {
    if (params.has("path")) {
      const result = await loadCommitDiffFile(
        authResult.user.id,
        sessionId,
        sha,
        params.get("path") ?? "",
      );
      if (result === null) {
        return NextResponse.json({ error: "No worktree for this chat" }, { status: 404 });
      }
      if ("error" in result) {
        return NextResponse.json({ error: result.error }, { status: result.status });
      }
      const body: CommitDiffFileContent = result;
      return NextResponse.json(body);
    }

    const files = await loadCommitDiff(authResult.user.id, sessionId, sha);
    if (files === null) {
      return NextResponse.json(
        { error: "No worktree for this chat, or no such commit" },
        { status: 404 },
      );
    }
    return NextResponse.json({ files });
  } catch (err) {
    if (err instanceof GitError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    console.error(`Failed to read commit diff for ${sessionId}:`, err);
    return NextResponse.json({ error: "Could not read the commit diff" }, { status: 500 });
  }
}
