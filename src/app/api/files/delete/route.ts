import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/api-body";
import { FilePathEscapeError } from "@/lib/files/errors";
import { fileErrorResponse, openRequestTarget, resolveRequestPath } from "@/lib/files/request";
import { deleteEntrySchema } from "@/lib/files/schema";

/**
 * POST /api/files/delete?target= — remove a file, or a folder and its contents.
 *
 * Deleting is recursive where it applies, so the workspace root is refused here
 * rather than trusted to the UI: there is no undo, and "remove the whole
 * workspace" is never what a row action meant.
 */
export async function POST(request: NextRequest) {
  try {
    const target = await openRequestTarget(request);
    if (!target.ok) return target.response;

    const body = await readJsonBody(request, deleteEntrySchema);
    if (!body.ok) return body.response;

    const path = resolveRequestPath(target.opened, body.data.path);
    if (path === target.opened.info.root) throw new FilePathEscapeError(path);

    await target.opened.provider.remove(path);
    return NextResponse.json({ path });
  } catch (err) {
    return fileErrorResponse(err, "POST /api/files/delete");
  }
}
