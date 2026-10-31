import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { FILE_MODIFIED_HEADER, MAX_PREVIEW_BYTES } from "@/lib/files/config";
import { FileLimitError, FileNotFoundError } from "@/lib/files/errors";
import { contentEtag, matchesEtag, streamedFileResponse } from "@/lib/files/http";
import { inlineSafeType, resolveMimeType } from "@/lib/files/mime";
import { baseName } from "@/lib/files/paths";
import { fileErrorResponse, openRequestTarget, resolveRequestPath } from "@/lib/files/request";

/**
 * GET /api/files/raw?target=&path=&download=
 *
 * One file's bytes. inline for the viewer, as an attachment for Download.
 *
 * Three things matter here. The response is keyed by the file and revalidated
 * (`no-cache` plus an ETag), because a workspace file is mutable while its URL
 * is not: without that, a second look at a file an agent rewrote shows the
 * bytes from the first look. Inline types that execute are downgraded to text,
 * so a workspace cannot XSS the app through its own origin. And the two paths
 * are split on what they cost: a preview is buffered and capped, a download is
 * streamed and has no ceiling, because only the preview ever holds the file.
 */
export async function GET(request: NextRequest) {
  try {
    const target = await openRequestTarget(request);
    if (!target.ok) return target.response;

    const params = request.nextUrl.searchParams;
    const filePath = resolveRequestPath(target.opened, params.get("path"));
    const download = params.get("download") === "1";

    const stat = await target.opened.provider.stat(filePath);
    if (!stat || stat.kind !== "file") throw new FileNotFoundError(filePath);

    const name = baseName(filePath);

    if (download) {
      return streamedFileResponse(request, {
        stream: await target.opened.provider.openReadStream(filePath),
        name,
        mimeType: resolveMimeType(name),
        size: stat.size,
        modified: stat.modified,
        download,
      });
    }

    if (stat.size > MAX_PREVIEW_BYTES) {
      throw new FileLimitError(`${name} is too large to preview. download it instead.`);
    }

    const file = await target.opened.provider.read(filePath);
    const etag = contentEtag(file.buffer);
    // The editor saves against the mtime its text came from, which is this one.
    const modified = String(stat.modified);

    if (matchesEtag(request.headers.get("if-none-match"), etag)) {
      return new NextResponse(null, {
        status: 304,
        headers: {
          ETag: etag,
          "Cache-Control": "private, no-cache",
          [FILE_MODIFIED_HEADER]: modified,
        },
      });
    }

    return new NextResponse(file.buffer, {
      headers: {
        "Content-Type": inlineSafeType(file.mimeType),
        "Content-Length": String(file.buffer.length),
        "Cache-Control": "private, no-cache",
        "X-Content-Type-Options": "nosniff",
        ETag: etag,
        [FILE_MODIFIED_HEADER]: modified,
      },
    });
  } catch (err) {
    return fileErrorResponse(err, "GET /api/files/raw");
  }
}
