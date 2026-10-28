import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/api-body";
import { MAX_PREVIEW_BYTES } from "@/lib/files/config";
import { FileLimitError, FileModifiedError, FileNotFoundError } from "@/lib/files/errors";
import { baseName } from "@/lib/files/paths";
import { fileErrorResponse, openRequestTarget, resolveRequestPath } from "@/lib/files/request";
import { writeFileSchema } from "@/lib/files/schema";
import { formatFileSize } from "@/lib/utils";

/**
 * POST /api/files/write?target=. replaces one file's text.
 *
 * The body is the whole file, because Monaco holds the buffer; a patch protocol
 * would be a second copy of the content to keep in step.
 *
 * `baseModified` is the mtime the editor loaded the file with. An agent writing
 * the same file mid-edit is ordinary in a coder chat, so a mismatch comes back
 * as a 409 the client turns into an overwrite offer instead of silently losing
 * whichever side wrote first. The ceiling matches the read ceiling: a file the
 * editor will not open is a file it cannot save.
 */
export async function POST(request: NextRequest) {
  try {
    const target = await openRequestTarget(request);
    if (!target.ok) return target.response;

    const body = await readJsonBody(request, writeFileSchema);
    if (!body.ok) return body.response;

    const filePath = resolveRequestPath(target.opened, body.data.path);
    const name = baseName(filePath);
    const bytes = Buffer.byteLength(body.data.content, "utf8");
    if (bytes > MAX_PREVIEW_BYTES) {
      throw new FileLimitError(`${name} is ${formatFileSize(bytes)}. Too large to save here.`);
    }

    // Only an existing file is saved: the editor has no "new file" mode, and a
    // typo in a path must not leave an empty file behind.
    const stat = await target.opened.provider.stat(filePath);
    if (!stat || stat.kind !== "file") throw new FileNotFoundError(filePath);
    if (
      !body.data.force &&
      body.data.baseModified !== undefined &&
      stat.modified !== body.data.baseModified
    ) {
      throw new FileModifiedError(name);
    }

    await target.opened.provider.write(filePath, Buffer.from(body.data.content, "utf8"));
    const written = await target.opened.provider.stat(filePath);

    return NextResponse.json({
      path: filePath,
      size: written?.size ?? bytes,
      modified: written?.modified ?? stat.modified,
    });
  } catch (err) {
    return fileErrorResponse(err, "POST /api/files/write");
  }
}
