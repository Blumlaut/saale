import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { councilCaller, councilErrorResponse, readJsonBody } from "@/lib/council/http";
import { memberInputSchema } from "@/lib/council/schema";
import { deleteMember, updateMember } from "@/lib/council/store";

/**
 * PATCH /api/council/[councilId]/members/[memberId]. edit one member.
 *
 * A member with turns behind it is edited, not resurrected: `enabled` is how a
 * member is taken out of a council, because deleting it would leave the room's
 * history pointing at a handle nobody answers.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ councilId: string; memberId: string }> },
) {
  const { councilId, memberId } = await params;
  const caller = await councilCaller();
  if (!caller.ok) return caller.response;

  const body = await readJsonBody(request, memberInputSchema);
  if (!body.ok) return body.response;

  try {
    const member = await updateMember(caller.userId, councilId, memberId, body.data);
    if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ member });
  } catch (err) {
    return councilErrorResponse(err, `PATCH /api/council/${councilId}/members/${memberId}`);
  }
}

/** DELETE /api/council/[councilId]/members/[memberId]. remove a member. */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ councilId: string; memberId: string }> },
) {
  const { councilId, memberId } = await params;
  const caller = await councilCaller();
  if (!caller.ok) return caller.response;

  try {
    const deleted = await deleteMember(caller.userId, councilId, memberId);
    if (!deleted) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ deleted: true });
  } catch (err) {
    return councilErrorResponse(err, `DELETE /api/council/${councilId}/members/${memberId}`);
  }
}
