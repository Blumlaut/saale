/**
 * Route plumbing shared by the council endpoints.
 *
 * Every council route does the same three things before it does anything else:
 * require a session, refuse unless the module is on and the caller is an admin,
 * and validate the body. Doing that once here keeps the routes to their own
 * logic — and keeps the answer to "who may read a council" identical across
 * eight files.
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type { z } from "zod";
import { requireSession } from "@/lib/auth";
import { requireCouncilAccess } from "./access";
import { CouncilBusyError, CouncilNotFoundError, CouncilUnavailableError } from "./run";
import { CouncilInputError } from "./store";
import { formatValidationError } from "./schema";

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

/** Parse and validate a JSON body, or produce the 400 to send instead. */
export async function readJsonBody<T>(
  request: NextRequest,
  schema: z.ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; response: NextResponse }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch (err) {
    // A body that is not JSON at all is the caller's mistake, not ours.
    console.error("Council request body was not valid JSON:", err);
    return {
      ok: false,
      response: NextResponse.json({ error: "Expected a JSON body" }, { status: 400 }),
    };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: NextResponse.json({ error: formatValidationError(parsed.error) }, { status: 400 }),
    };
  }
  return { ok: true, data: parsed.data };
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
