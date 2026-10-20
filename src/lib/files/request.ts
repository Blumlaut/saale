/**
 * Route plumbing for the file endpoints.
 *
 * Every file route starts the same way: a session, a target token turned into a
 * provider, a requested path resolved and confined to that provider's root, and
 * an error taxonomy translated into statuses. All of it lives here so a route
 * body is only ever about the one thing it does.
 *
 * This is the single place the generic file module reaches into the council
 * feature: the council target needs the council's sandbox identity and its
 * access rules. Removing the council module means deleting the import, the
 * `council:` branch below, and `src/lib/council/files.ts`. nothing else in
 * `src/lib/files` knows council exists.
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { requireCouncilAccess } from "@/lib/council/access";
import { openCouncilFileTarget } from "@/lib/council/files";
import {
  FileConflictError,
  FileLimitError,
  FileNotFoundError,
  FilePathEscapeError,
  WorkspaceUnavailableError,
} from "./errors";
import { isSafeEntryName, requireWithinRoot } from "./paths";
import { openUserFileTarget, parseFileTarget, type OpenedFileTarget } from "./targets";

/** The workspace this request is about, or the response that refuses it. */
export async function openRequestTarget(
  request: NextRequest,
): Promise<{ ok: true; opened: OpenedFileTarget } | { ok: false; response: NextResponse }> {
  const session = await requireSession();
  if (!session.ok) return { ok: false, response: session.response };

  const ref = parseFileTarget(request.nextUrl.searchParams.get("target"));
  if (!ref) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unknown file target" }, { status: 400 }),
    };
  }

  if (ref.kind === "council") {
    // Same gate and same 404 as every other council endpoint: whether the
    // module exists is not something an unauthorised caller needs to learn.
    const denied = await requireCouncilAccess(session.user.id);
    if (denied) return { ok: false, response: denied };

    const opened = await openCouncilFileTarget(session.user.id, ref.councilId);
    if (!opened) {
      return { ok: false, response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
    }
    return { ok: true, opened };
  }

  return { ok: true, opened: await openUserFileTarget(session.user.id) };
}

/**
 * Resolve a caller-supplied path against an opened target.
 *
 * Empty, missing and `/` all mean the workspace root. that is how a browser
 * opens, and "the root" of a workspace is not the root of the filesystem, which
 * stays refused.
 */
export function resolveRequestPath(opened: OpenedFileTarget, requested: string | null): string {
  const path = requested && requested !== "/" ? requested : opened.info.root;
  return requireWithinRoot(opened.info.root, path);
}

/** A child of `dir` named `name`, refusing a name that is not one path segment. */
export function childPath(dir: string, name: string): string {
  if (!isSafeEntryName(name)) throw new FilePathEscapeError(name);
  return `${dir === "/" ? "" : dir}/${name}`;
}

/** Map a thrown file error onto a status. */
export function fileErrorResponse(err: unknown, context: string): NextResponse {
  if (err instanceof FilePathEscapeError) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  if (err instanceof FileNotFoundError) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (err instanceof FileConflictError) {
    return NextResponse.json({ error: err.message, conflicts: err.conflicts }, { status: 409 });
  }
  if (err instanceof FileLimitError) {
    return NextResponse.json({ error: err.message }, { status: 413 });
  }
  if (err instanceof WorkspaceUnavailableError) {
    return NextResponse.json({ error: err.message }, { status: 409 });
  }

  console.error(`${context}:`, err);
  return NextResponse.json({ error: "File request failed" }, { status: 500 });
}
