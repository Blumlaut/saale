/**
 * Route plumbing shared by the council endpoints.
 *
 * Every council route does the same three things before it does anything else:
 * require a session, refuse unless the module is on and the caller is an admin,
 * and validate the body. Doing that once here keeps the routes to their own
 * logic — and keeps the answer to "who may read a council" identical across
 * eight files.
 */

import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { requireCouncilAccess } from "./access";
import { CouncilBusyError, CouncilNotFoundError, CouncilUnavailableError } from "./run";
import { CouncilInputError } from "./store";

// Re-exported so the council routes keep one import for their plumbing; the
// implementation is shared with the file endpoints.
export { readJsonBody } from "@/lib/api-body";

/** The caller, or the response that refuses them. */
export async function councilCaller(): Promise<
  { ok: true; userId: string } | { ok: false; response: NextResponse }
> {
  const session = await requireSession();
  if (!session.ok) return { ok: false, response: session.response };

  const denied = await requireCouncilAccess(session.user.id);
  if (denied) return { ok: false, response: denied };

  return { ok: true, userId: session.user.id };
}

/**
 * Map a thrown council error onto a status.
 *
 * The unfamiliar cases are the two the loop raises: a council already running is
 * a conflict the room UI shows as "it is working", and a council that cannot get
 * a sandbox is a server-side shortfall rather than a bad request.
 */
export function councilErrorResponse(err: unknown, context: string): NextResponse {
  if (err instanceof CouncilNotFoundError) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (err instanceof CouncilInputError) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  if (err instanceof CouncilBusyError) {
    return NextResponse.json({ error: "This council is already running." }, { status: 409 });
  }
  if (err instanceof CouncilUnavailableError) {
    return NextResponse.json({ error: err.message }, { status: 409 });
  }

  console.error(`${context}:`, err);
  return NextResponse.json({ error: "Council request failed" }, { status: 500 });
}
