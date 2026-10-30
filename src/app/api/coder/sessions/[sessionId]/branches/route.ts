import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { loadChatCheckout } from "@/lib/coder/checkout";
import { GitError, readBranches } from "@/lib/coder/git";

/**
 * GET /api/coder/sessions/:id/branches. The branches the checkout can switch to.
 *
 * Asked when the branch menu opens rather than with every status read: the menu
 * is opened rarely and a branch list is a git call nobody else needs.
 */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { sessionId } = await context.params;

  try {
    const checkout = await loadChatCheckout(authResult.user.id, sessionId);
    if (!checkout) return NextResponse.json({ branches: [] });
    const branches = await readBranches(authResult.user.id, checkout.path);
    return NextResponse.json({ branches });
  } catch (err) {
    if (err instanceof GitError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    console.error(`Failed to list branches for chat ${sessionId}:`, err);
    return NextResponse.json({ error: "Could not list the branches" }, { status: 500 });
  }
}
