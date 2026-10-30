import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { createPullRequest, PullRequestError, readPullRequest } from "@/lib/coder/pull-request";

/**
 * GET /api/coder/sessions/:id/pull-request. The pull request the chat's branch
 * is on, or null.
 *
 * Asked on its own, not as part of the status read: `gh` talks to the forge, and
 * a panel that refreshed its changes every 20 seconds must not cost a network
 * round trip for a badge.
 */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { sessionId } = await context.params;
  const pullRequest = await readPullRequest(authResult.user.id, sessionId);
  return NextResponse.json({ pullRequest });
}

const createSchema = z.object({ draft: z.boolean().default(false) });

/** POST /api/coder/sessions/:id/pull-request. Open one for the branch. */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { sessionId } = await context.params;
  const body = await request.json().catch((err: unknown) => {
    console.error(`Unreadable pull request body for ${sessionId}:`, err);
    return {};
  });
  const parsed = createSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "Expected { draft? }" }, { status: 400 });
  }

  try {
    const pullRequest = await createPullRequest(authResult.user.id, sessionId, {
      draft: parsed.data.draft,
    });
    return NextResponse.json({ pullRequest });
  } catch (err) {
    if (err instanceof PullRequestError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error(`Failed to open a pull request for chat ${sessionId}:`, err);
    return NextResponse.json({ error: "Could not open a pull request" }, { status: 500 });
  }
}
