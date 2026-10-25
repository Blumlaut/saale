import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { CHAT_MODES } from "@/lib/coder/checkout";
import { removeProject } from "@/lib/coder/cleanup";
import {
  CoderProjectError,
  getProject,
  serializeProjectDetail,
  updateProject,
} from "@/lib/coder/projects";
import { CoderCleanupError } from "@/lib/coder/worktree-removal";
import { cleanupRefusalResponse } from "@/lib/coder/cleanup-response";
import { forceRequested } from "@/lib/coder/force-delete";
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
 * What a project hands to each of its worktrees.
 *
 * `envFiles` carries the paths and contents; the lib checks each path stays
 * inside the checkout. An absent field is left as it is, so the panel can save
 * one tab without sending the other.
 */
const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  defaultBranch: z.string().min(1).max(200).optional(),
  chatMode: z.enum(CHAT_MODES).optional(),
  envFiles: z.array(z.object({ path: z.string(), content: z.string() })).optional(),
  setupScript: z.string().nullable().optional(),
});

/** PATCH /api/coder/projects/:projectId: name, branch, chat mode, env files, setup script. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json().catch((err: unknown) => {
    console.error(`Unreadable coder project settings body for ${projectId}:`, err);
    return null;
  });
  const parsed = updateProjectSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Expected { name?, defaultBranch?, chatMode?, envFiles?, setupScript? }" },
      { status: 400 },
    );
  }

  try {
    const project = await updateProject(authResult.user.id, projectId, parsed.data);
    return NextResponse.json({ project });
  } catch (err) {
    if (err instanceof CoderProjectError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error(`Failed to update coder project ${projectId}:`, err);
    return NextResponse.json({ error: "Failed to save the project settings" }, { status: 500 });
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

  try {
    await removeProject(authResult.user.id, projectId, forceRequested(request.url));
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof CoderCleanupError) return cleanupRefusalResponse(err);
    console.error(`Failed to delete coder project ${projectId}:`, err);
    return NextResponse.json({ error: "Could not delete the project" }, { status: 500 });
  }
}
