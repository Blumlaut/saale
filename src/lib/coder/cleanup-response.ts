import { NextResponse } from "next/server";
import type { CoderCleanupError } from "./worktree-removal";

/**
 * The answer a refused coder delete sends back.
 *
 * The message is git's own reason, and the code tells the dialog whether a
 * confirmed retry would get past it.
 */
export function cleanupRefusalResponse(error: CoderCleanupError): NextResponse {
  return NextResponse.json(
    { error: error.message, ...(error.code ? { code: error.code } : {}) },
    { status: error.status },
  );
}
