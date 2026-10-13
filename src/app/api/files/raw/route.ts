import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { MAX_DOWNLOAD_BYTES, MAX_PREVIEW_BYTES } from "@/lib/files/config";
import { FileLimitError, FileNotFoundError } from "@/lib/files/errors";
import { formatFileSize } from "@/lib/utils";
import { contentDisposition, contentEtag, matchesEtag } from "@/lib/files/http";
import { inlineSafeType } from "@/lib/files/mime";
import { baseName } from "@/lib/files/paths";
import { fileErrorResponse, openRequestTarget, resolveRequestPath } from "@/lib/files/request";

/**
 * GET /api/files/raw?target=&path=&download=
 *
 * One file's bytes — inline for the viewer, as an attachment for Download.
 *
 * Three things matter here. The response is keyed by content and revalidated
 * (`no-cache` + a content ETag), because a workspace file is mutable while its
 * URL is not: without that, a second look at a file an agent rewrote shows the
 * bytes from the first look. Inline types that execute are downgraded to text,
 * so a workspace cannot XSS the app through its own origin. And the read is
 * bounded, because a workspace read returns the whole file as one buffer.
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
    if (stat.size > MAX_DOWNLOAD_BYTES) {
      throw new FileLimitError(
        `${name} is ${formatFileSize(stat.size)} — larger than the ${formatFileSize(MAX_DOWNLOAD_BYTES)} limit for opening a file here.`,
      );
    }
    if (!download && stat.size > MAX_PREVIEW_BYTES) {
      throw new FileLimitError(`${name} is too large to preview — download it instead.`);
    }

    const file = await target.opened.provider.read(filePath);
    const etag = contentEtag(file.buffer);

    if (matchesEtag(request.headers.get("if-none-match"), etag)) {
      return new NextResponse(null, {
        status: 304,
        headers: { ETag: etag, "Cache-Control": "private, no-cache" },
      });
    }

    return new NextResponse(file.buffer, {
      headers: {
        "Content-Type": download ? file.mimeType : inlineSafeType(file.mimeType),
        "Content-Length": String(file.buffer.length),
        "Cache-Control": "private, no-cache",
        "X-Content-Type-Options": "nosniff",
        ETag: etag,
        ...(download ? { "Content-Disposition": contentDisposition(name) } : {}),
      },
    });
  } catch (err) {
    return fileErrorResponse(err, "GET /api/files/raw");
  }
}
