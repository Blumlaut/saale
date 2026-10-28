import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/api-body";
import { FileConflictError } from "@/lib/files/errors";
import {
  childPath,
  fileErrorResponse,
  openRequestTarget,
  resolveRequestPath,
} from "@/lib/files/request";
import { createFileSchema } from "@/lib/files/schema";

/**
 * POST /api/files/create?target=. a new empty file inside the current directory.
 *
 * Empty, not "created empty and then written": the write endpoint refuses a
 * path that does not exist, so a file only ever appears here or through an
 * upload, and a typo cannot leave an empty file behind.
 */
export async function POST(request: NextRequest) {
  try {
    const target = await openRequestTarget(request);
    if (!target.ok) return target.response;

    const body = await readJsonBody(request, createFileSchema);
    if (!body.ok) return body.response;

    const dir = resolveRequestPath(target.opened, body.data.path);
    const path = childPath(dir, body.data.name);

    // Replacing something an agent may be working in is not this endpoint's
    // job; a name that is taken is a conflict the user can see.
    if (await target.opened.provider.stat(path)) throw new FileConflictError([body.data.name]);

    await target.opened.provider.write(path, Buffer.alloc(0));
    return NextResponse.json({ path });
  } catch (err) {
    return fileErrorResponse(err, "POST /api/files/create");
  }
}
