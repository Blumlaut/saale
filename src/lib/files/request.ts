/**
 * Route plumbing for the file endpoints.
 *
 * Every file route starts the same way: a session, a target token turned into a
 * provider, a requested path resolved and confined to that provider's root, and
 * an error taxonomy translated into statuses. All of it lives here so a route
 * body is only ever about the one thing it does.
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import {
  FileConflictError,
  FileLimitError,
  FileModifiedError,
  FileNotFoundError,
  FilePathEscapeError,
  FileUploadError,
  WorkspaceUnavailableError,
} from "./errors";
import { isSafeEntryName, requireWithinRoot } from "./paths";
import { USER_FILE_TARGET, openUserFileTarget, type OpenedFileTarget } from "./targets";

/** The workspace this request is about, or the response that refuses it. */
export async function openRequestTarget(
  request: NextRequest,
): Promise<{ ok: true; opened: OpenedFileTarget } | { ok: false; response: NextResponse }> {
  const session = await requireSession();
  if (!session.ok) return { ok: false, response: session.response };

  const target = request.nextUrl.searchParams.get("target");
  if (target !== null && target !== "" && target !== USER_FILE_TARGET) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unknown file target" }, { status: 400 }),
    };
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
  if (err instanceof FileModifiedError) {
    // `code` lets the client tell this apart from a name conflict, which it
    // answers by offering an overwrite.
    return NextResponse.json({ error: err.message, code: "modified" }, { status: 409 });
  }
  if (err instanceof FileConflictError) {
    return NextResponse.json({ error: err.message, conflicts: err.conflicts }, { status: 409 });
  }
  if (err instanceof FileLimitError) {
    return NextResponse.json({ error: err.message }, { status: 413 });
  }
  if (err instanceof FileUploadError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof WorkspaceUnavailableError) {
    return NextResponse.json({ error: err.message }, { status: 409 });
  }

  console.error(`${context}:`, err);
  return NextResponse.json({ error: "File request failed" }, { status: 500 });
}
