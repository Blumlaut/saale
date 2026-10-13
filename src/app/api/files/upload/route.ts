import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  MAX_UPLOAD_BYTES_PER_FILE,
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_TOTAL_BYTES,
} from "@/lib/files/config";
import { formatFileSize } from "@/lib/utils";
import { isSafeEntryName } from "@/lib/files/paths";
import {
  childPath,
  fileErrorResponse,
  openRequestTarget,
  resolveRequestPath,
} from "@/lib/files/request";

/** Why a file in the request was not written. */
type SkipReason = "exists" | "invalid-name" | "too-large";

/**
 * POST /api/files/upload?target=&dir=&overwrite=
 *
 * Multipart, one request per batch. The whole body is parsed into memory before
 * the first write, which is what the total-size ceiling is really about.
 *
 * An existing name is *not* replaced by default: these are files an agent may be
 * working in, and the workspace API would overwrite them silently. Conflicts come
 * back in `skipped` and the browser offers to replace them, which is one click
 * and never a surprise.
 */
export async function POST(request: NextRequest) {
  try {
    const target = await openRequestTarget(request);
    if (!target.ok) return target.response;

    const params = request.nextUrl.searchParams;
    const dir = resolveRequestPath(target.opened, params.get("dir"));
    const overwrite = params.get("overwrite") === "1";

    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_UPLOAD_TOTAL_BYTES) {
      return NextResponse.json(
        { error: `Upload is larger than ${formatFileSize(MAX_UPLOAD_TOTAL_BYTES)}` },
        { status: 413 },
      );
    }

    const form = await request.formData();
    const files = form.getAll("files").filter((value): value is File => value instanceof File);

    if (files.length === 0) {
      return NextResponse.json({ error: "No files in the request" }, { status: 400 });
    }
    if (files.length > MAX_UPLOAD_FILES) {
      return NextResponse.json(
        { error: `Upload at most ${MAX_UPLOAD_FILES} files at a time` },
        { status: 413 },
      );
    }

    const uploaded: string[] = [];
    const skipped: { name: string; reason: SkipReason }[] = [];

    for (const file of files) {
      if (!isSafeEntryName(file.name)) {
        skipped.push({ name: file.name, reason: "invalid-name" });
        continue;
      }
      if (file.size > MAX_UPLOAD_BYTES_PER_FILE) {
        skipped.push({ name: file.name, reason: "too-large" });
        continue;
      }

      const path = childPath(dir, file.name);
      if (!overwrite && (await target.opened.provider.stat(path))) {
        skipped.push({ name: file.name, reason: "exists" });
        continue;
      }

      await target.opened.provider.write(path, Buffer.from(await file.arrayBuffer()));
      uploaded.push(file.name);
    }

    return NextResponse.json({ uploaded, skipped });
  } catch (err) {
    return fileErrorResponse(err, "POST /api/files/upload");
  }
}
