import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/api-body";
import { fileErrorResponse, openRequestTarget, resolveRequestPath } from "@/lib/files/request";
import { beginUploadSchema } from "@/lib/files/schema";
import { beginUpload } from "@/lib/files/upload";

/**
 * POST /api/files/upload/init?target=&overwrite=
 *
 * First step of every upload: checks the destination and hands back the id the
 * chunks are named with. A name that is already taken is a 409 here, before the
 * bytes are shipped, and the browser offers to replace them.
 */
export async function POST(request: NextRequest) {
  try {
    const target = await openRequestTarget(request);
    if (!target.ok) return target.response;

    const body = await readJsonBody(request, beginUploadSchema);
    if (!body.ok) return body.response;

    const overwrite = request.nextUrl.searchParams.get("overwrite") === "1";
    const { uploadId } = await beginUpload(
      target.opened,
      {
        dir: resolveRequestPath(target.opened, body.data.path),
        name: body.data.name,
        size: body.data.size,
      },
      { overwrite, inbox: body.data.inbox === true },
    );

    return NextResponse.json({ uploadId });
  } catch (err) {
    return fileErrorResponse(err, "POST /api/files/upload/init");
  }
}
