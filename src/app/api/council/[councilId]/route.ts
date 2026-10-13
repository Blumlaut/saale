import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { councilCaller, councilErrorResponse, readJsonBody } from "@/lib/council/http";
import { councilUpdateSchema } from "@/lib/council/schema";
import { getCouncil, updateCouncil, deleteCouncil } from "@/lib/council/store";
import { destroyCouncilSandbox } from "@/lib/council/sandbox";
import { sandboxIdentity } from "@/lib/council/accounts";
import { prisma } from "@/lib/db";

/**
 * GET /api/council/[councilId] — the council, its members and its recent runs.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ councilId: string }> },
) {
  const { councilId } = await params;
  const caller = await councilCaller();
  if (!caller.ok) return caller.response;

  try {
    const council = await getCouncil(caller.userId, councilId);
    if (!council) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ council });
  } catch (err) {
    return councilErrorResponse(err, `GET /api/council/${councilId}`);
  }
}

/** PATCH /api/council/[councilId] — edit the council's own settings. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ councilId: string }> },
) {
  const { councilId } = await params;
  const caller = await councilCaller();
  if (!caller.ok) return caller.response;

  const body = await readJsonBody(request, councilUpdateSchema);
  if (!body.ok) return body.response;

  try {
    const council = await updateCouncil(caller.userId, councilId, body.data);
    if (!council) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ council });
  } catch (err) {
    return councilErrorResponse(err, `PATCH /api/council/${councilId}`);
  }
}

/**
 * DELETE /api/council/[councilId] — delete the council and its sandbox.
 *
 * The rows go first: they are the record the user asked to be rid of, and the
 * container cleanup depends on reaching a service that may be down. The account
 * removal is best-effort and reported — it is the difference between a workspace
 * that is gone and one that is merely unreferenced, so it is worth knowing.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ councilId: string }> },
) {
  const { councilId } = await params;
  const caller = await councilCaller();
  if (!caller.ok) return caller.response;

  try {
    const existing = await prisma.council.findFirst({
      where: { id: councilId, userId: caller.userId },
      select: { sandboxKey: true },
    });
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const deleted = await deleteCouncil(caller.userId, councilId);
    if (!deleted) return NextResponse.json({ error: "Not found" }, { status: 404 });

    try {
      await destroyCouncilSandbox(sandboxIdentity(existing.sandboxKey));
    } catch (err) {
      // The council is gone either way; say so rather than reporting a failure
      // that would suggest the delete did not happen.
      console.warn(`Council ${councilId} was deleted but its sandbox was not:`, err);
      return NextResponse.json({ deleted: true, sandboxRemoved: false });
    }

    return NextResponse.json({ deleted: true, sandboxRemoved: true });
  } catch (err) {
    return councilErrorResponse(err, `DELETE /api/council/${councilId}`);
  }
}
