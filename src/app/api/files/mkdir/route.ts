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
import { createDirectorySchema } from "@/lib/files/schema";

/** POST /api/files/mkdir?target= — a new folder inside the current directory. */
export async function POST(request: NextRequest) {
  try {
    const target = await openRequestTarget(request);
    if (!target.ok) return target.response;

    const body = await readJsonBody(request, createDirectorySchema);
    if (!body.ok) return body.response;

    const dir = resolveRequestPath(target.opened, body.data.path);
    const path = childPath(dir, body.data.name);

    // `mkdir -p` would quietly accept a name that is already taken; a person who
    // asked for "notes" deserves to hear that it exists.
    if (await target.opened.provider.stat(path)) throw new FileConflictError([body.data.name]);

    await target.opened.provider.createDirectory(path);
    return NextResponse.json({ path });
  } catch (err) {
    return fileErrorResponse(err, "POST /api/files/mkdir");
  }
}
