import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { MAX_UPLOAD_CHUNK_BYTES } from "@/lib/files/config";
import { fileErrorResponse, openRequestTarget } from "@/lib/files/request";
import { appendUploadChunk } from "@/lib/files/upload";
import { formatFileSize } from "@/lib/utils";

/**
 * PUT /api/files/upload/chunk?target=&id=&index=
 *
 * One slice of an upload, appended to the staged file. `index` is what makes a
 * lost or repeated chunk an error the client can retry instead of a file with a
 * hole in it.
 */
export async function PUT(request: NextRequest) {
  try {
    const target = await openRequestTarget(request);
    if (!target.ok) return target.response;

    const params = request.nextUrl.searchParams;
    const uploadId = params.get("id");
    const index = Number(params.get("index"));
    if (!uploadId) {
      return NextResponse.json({ error: "Missing upload id" }, { status: 400 });
    }
    if (!Number.isInteger(index) || index < 0) {
      return NextResponse.json({ error: "Missing chunk index" }, { status: 400 });
    }

    // Refuse an oversized body before reading it: past the proxy's ceiling the
    // request would arrive truncated, and a short chunk reads as a corrupt file.
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_UPLOAD_CHUNK_BYTES) {
      return NextResponse.json(
        { error: `A chunk may be at most ${formatFileSize(MAX_UPLOAD_CHUNK_BYTES)}` },
        { status: 413 },
      );
    }

    const chunk = Buffer.from(await request.arrayBuffer());
    const { received } = await appendUploadChunk(target.opened, uploadId, index, chunk);

    return NextResponse.json({ received });
  } catch (err) {
    return fileErrorResponse(err, "PUT /api/files/upload/chunk");
  }
}
