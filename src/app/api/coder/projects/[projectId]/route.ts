import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { removeProject } from "@/lib/coder/cleanup";
import { getProject, serializeProjectDetail } from "@/lib/coder/projects";
import { CoderCleanupError } from "@/lib/coder/worktree-removal";
import { getActiveSessions } from "@/lib/redis";

/**
 * GET /api/coder/projects/:projectId: the project and its coder chats.
 *
 * `isGenerating` comes from Redis, the same source the chat list uses, so a
 * chat's spinner in the coder panel matches the one in the chat list.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  try {
    const project = await getProject(authResult.user.id, projectId);
    if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const generating = await getActiveSessions(authResult.user.id);
    return NextResponse.json(serializeProjectDetail(project, generating));
  } catch (err) {
    console.error(`Failed to load coder project ${projectId}:`, err);
    return NextResponse.json({ error: "Failed to load the project" }, { status: 500 });
  }
}

/**
 * DELETE /api/coder/projects/:projectId
 *
 * Removes the project's worktrees through git first. A checkout holding
 * uncommitted work refuses, and the project (and every chat in it) stays, so a
 * delete never takes the only copy of anything.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const force = new URL(request.url).searchParams.get("force") === "1";
  try {
    await removeProject(authResult.user.id, projectId, force);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof CoderCleanupError) {
      return NextResponse.json(
        { error: err.message, ...(err.code ? { code: err.code } : {}) },
        { status: err.status },
      );
    }
    console.error(`Failed to delete coder project ${projectId}:`, err);
    return NextResponse.json({ error: "Could not delete the project" }, { status: 500 });
  }
}
