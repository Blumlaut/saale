import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import {
  GitActionNotReadyError,
  GitActionRefusedError,
  MAX_ACTION_PATHS,
  MAX_COMMIT_MESSAGE,
  runGitAction,
  type GitAction,
} from "@/lib/coder/actions";
import { assertRepoRelativePath } from "@/lib/coder/changes";
import { GitError } from "@/lib/coder/git";

/**
 * POST /api/coder/sessions/:id/git. The panel's write actions: fetch, pull,
 * push, commit, stage, discard, switch a branch, stash.
 *
 * The body names what to do and nothing about where: the checkout comes from
 * the chat's row. Paths are repo-relative and checked here, so a path is never
 * taken on trust from a client.
 */

/** A repo-relative path, refused rather than cleaned when it is not one. */
const pathSchema = z
  .string()
  .min(1)
  .max(4096)
  .transform((value, ctx) => {
    try {
      return assertRepoRelativePath(value);
    } catch {
      ctx.addIssue({ code: "custom", message: `${value} is not a path inside the worktree` });
      return z.NEVER;
    }
  });

const pathsSchema = z.array(pathSchema).max(MAX_ACTION_PATHS);

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("fetch") }),
  z.object({ action: z.literal("pull"), rebase: z.boolean().default(false) }),
  z.object({ action: z.literal("push") }),
  z.object({
    action: z.literal("commit"),
    message: z.string().max(MAX_COMMIT_MESSAGE),
    amend: z.boolean().default(false),
    push: z.boolean().default(false),
  }),
  z.object({ action: z.literal("stage"), paths: pathsSchema.default([]) }),
  z.object({ action: z.literal("unstage"), paths: pathsSchema.default([]) }),
  z.object({ action: z.literal("discard"), paths: pathsSchema }),
  z.object({
    action: z.literal("branch"),
    name: z.string().min(1).max(244),
    create: z.boolean().default(false),
  }),
  z.object({ action: z.literal("stash") }),
  z.object({ action: z.literal("stash-pop") }),
  z.object({ action: z.literal("undo-commit") }),
]);

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { sessionId } = await context.params;

  const body = await request.json().catch((err: unknown) => {
    console.error(`Unreadable git action body for ${sessionId}:`, err);
    return null;
  });
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message;
    return NextResponse.json(
      { error: first ?? "That git action is not one this panel offers" },
      { status: 400 },
    );
  }

  try {
    const result = await runGitAction(
      authResult.user.id,
      sessionId,
      parsed.data satisfies GitAction,
    );
    if (!result) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    return NextResponse.json({ ok: true, output: result.output });
  } catch (err) {
    if (err instanceof GitActionNotReadyError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof GitActionRefusedError || err instanceof GitError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error(`Failed to run ${parsed.data.action} for chat ${sessionId}:`, err);
    return NextResponse.json({ error: "Could not run that git command" }, { status: 500 });
  }
}
