import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { councilCaller, councilErrorResponse } from "@/lib/council/http";
import { getCouncil, listMemberTurns } from "@/lib/council/store";

/** How many turns one page of the subpage returns. */
const MAX_TURNS_PAGE = 100;

/**
 * GET /api/council/[councilId]/turns?memberId=…&runId=…
 *
 * A member's private turns. what woke it, what it reasoned, the tool calls it
 * made and the closing text it never sent. `runId` narrows it to one run, which
 * is what the subpage's run selector does.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ councilId: string }> },
) {
  const { councilId } = await params;
  const caller = await councilCaller();
  if (!caller.ok) return caller.response;

  const { searchParams } = new URL(request.url);
  const memberId = searchParams.get("memberId");
  if (!memberId) {
    return NextResponse.json({ error: "memberId is required" }, { status: 400 });
  }
  const runId = searchParams.get("runId") ?? undefined;
  const limit = Math.min(
    MAX_TURNS_PAGE,
    Math.max(1, Number.parseInt(searchParams.get("limit") ?? "30", 10) || 30),
  );

  try {
    // The council is loaded first so a member id from another council (or another
    // user) cannot be read through this route.
    const council = await getCouncil(caller.userId, councilId);
    if (!council) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (!council.members.some((member) => member.id === memberId)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const turns = await listMemberTurns(caller.userId, councilId, {
      memberId,
      ...(runId ? { runId } : {}),
      limit,
    });
    return NextResponse.json({ turns });
  } catch (err) {
    return councilErrorResponse(err, `GET /api/council/${councilId}/turns`);
  }
}
