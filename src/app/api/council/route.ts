import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { councilCaller, councilErrorResponse, readJsonBody } from "@/lib/council/http";
import { councilCreateSchema } from "@/lib/council/schema";
import { createCouncil, listCouncils } from "@/lib/council/store";

/**
 * GET /api/council — the caller's councils.
 *
 * `requireCouncilAccess` in `councilCaller` answers 404 when the module is off or
 * the caller is not an admin, so the endpoints exist only for admins.
 */
export async function GET() {
  const caller = await councilCaller();
  if (!caller.ok) return caller.response;

  try {
    return NextResponse.json({ councils: await listCouncils(caller.userId) });
  } catch (err) {
    return councilErrorResponse(err, "GET /api/council");
  }
}

/** POST /api/council — create a council with its first members. */
export async function POST(request: NextRequest) {
  const caller = await councilCaller();
  if (!caller.ok) return caller.response;

  const body = await readJsonBody(request, councilCreateSchema);
  if (!body.ok) return body.response;

  try {
    const council = await createCouncil(caller.userId, body.data);
    return NextResponse.json({ council }, { status: 201 });
  } catch (err) {
    return councilErrorResponse(err, "POST /api/council");
  }
}
