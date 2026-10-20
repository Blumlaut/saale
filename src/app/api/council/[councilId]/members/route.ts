import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { councilCaller, councilErrorResponse, readJsonBody } from "@/lib/council/http";
import { memberInputSchema } from "@/lib/council/schema";
import { MAX_MEMBERS } from "@/lib/council/config";
import { addMember, getCouncil } from "@/lib/council/store";

/** POST /api/council/[councilId]/members. add a member to a council. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ councilId: string }> },
) {
  const { councilId } = await params;
  const caller = await councilCaller();
  if (!caller.ok) return caller.response;

  const body = await readJsonBody(request, memberInputSchema);
  if (!body.ok) return body.response;

  try {
    const council = await getCouncil(caller.userId, councilId);
    if (!council) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (council.memberCount >= MAX_MEMBERS) {
      return NextResponse.json(
        { error: `A council has at most ${MAX_MEMBERS} members.` },
        { status: 400 },
      );
    }

    const member = await addMember(caller.userId, councilId, body.data);
    if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ member }, { status: 201 });
  } catch (err) {
    return councilErrorResponse(err, `POST /api/council/${councilId}/members`);
  }
}
