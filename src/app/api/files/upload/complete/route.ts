import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/api-body";
import { fileErrorResponse, openRequestTarget, resolveRequestPath } from "@/lib/files/request";
import { completeUploadSchema } from "@/lib/files/schema";
import { finishUpload } from "@/lib/files/upload";

/**
 * POST /api/files/upload/complete?target=&overwrite=
 *
 * Last step: the assembled bytes are moved onto the destination. A name that
 * was taken while the chunks were in flight is refused here too, so nothing
 * replaces a file the user never agreed to replace.
 */
export async function POST(request: NextRequest) {
  try {
    const target = await openRequestTarget(request);
    if (!target.ok) return target.response;

    const body = await readJsonBody(request, completeUploadSchema);
    if (!body.ok) return body.response;

    const overwrite = request.nextUrl.searchParams.get("overwrite") === "1";
    const { path } = await finishUpload(
      target.opened,
      body.data.uploadId,
      {
        dir: resolveRequestPath(target.opened, body.data.path),
        name: body.data.name,
        size: body.data.size,
      },
      overwrite,
    );

    return NextResponse.json({ uploaded: body.data.name, path });
  } catch (err) {
    return fileErrorResponse(err, "POST /api/files/upload/complete");
  }
}
