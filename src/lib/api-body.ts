/**
 * JSON request plumbing shared by every write endpoint.
 *
 * Validation failures are turned into one message here (and nowhere else) so a
 * 400 reads the same whichever route produced it: a bare zod issue list is not
 * something a caller can act on.
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type { z } from "zod";

/** Format a zod failure for an API response. */
export function formatValidationError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
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
    console.error("Request body was not valid JSON:", err);
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
