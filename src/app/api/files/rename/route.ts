import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/api-body";
import { FileConflictError, FilePathEscapeError } from "@/lib/files/errors";
import { dirName } from "@/lib/files/paths";
import {
  childPath,
  fileErrorResponse,
  openRequestTarget,
  resolveRequestPath,
} from "@/lib/files/request";
import { renameEntrySchema } from "@/lib/files/schema";

/**
 * POST /api/files/rename?target=. rename or move one entry within a directory.
 *
 * The destination is the entry's own parent plus the new name, so a rename can
 * never move a file out of the folder it was in (and never out of the workspace).
 */
export async function POST(request: NextRequest) {
  try {
    const target = await openRequestTarget(request);
    if (!target.ok) return target.response;

    const body = await readJsonBody(request, renameEntrySchema);
    if (!body.ok) return body.response;

    const path = resolveRequestPath(target.opened, body.data.path);
    if (path === target.opened.info.root) throw new FilePathEscapeError(path);

    const destination = childPath(dirName(path), body.data.name);
    if (destination !== path && (await target.opened.provider.stat(destination))) {
      throw new FileConflictError([body.data.name]);
    }

    await target.opened.provider.rename(path, destination);
    return NextResponse.json({ path: destination });
  } catch (err) {
    return fileErrorResponse(err, "POST /api/files/rename");
  }
}
