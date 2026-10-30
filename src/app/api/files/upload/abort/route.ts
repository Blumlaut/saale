import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/api-body";
import { fileErrorResponse, openRequestTarget } from "@/lib/files/request";
import { abortUploadSchema } from "@/lib/files/schema";
import { abortUpload } from "@/lib/files/upload";

/**
 * POST /api/files/upload/abort?target=
 *
 * Drop an upload's staged bytes. A client that gave up sends this so a
 * half-shipped file does not sit in the workspace taking up room.
 */
export async function POST(request: NextRequest) {
  try {
    const target = await openRequestTarget(request);
    if (!target.ok) return target.response;

    const body = await readJsonBody(request, abortUploadSchema);
    if (!body.ok) return body.response;

    await abortUpload(target.opened, body.data.uploadId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fileErrorResponse(err, "POST /api/files/upload/abort");
  }
}
