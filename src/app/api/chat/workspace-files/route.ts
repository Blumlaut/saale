import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { contentEtag, matchesEtag, streamedFileResponse } from "@/lib/files/http";
import { readWorkspaceFile, resolveWorkspaceFile } from "@/lib/files/workspace-file";
import { FileNotFoundError, FilePathEscapeError } from "@/lib/files/errors";

/**
 * GET /api/chat/workspace-files?file=relative/path[&session=chatId][&download=1]
 *
 * Serve a file from the authenticated user's workspace.
 * Used by the show_file tool's FileCard component for on-demand file delivery.
 *
 * Inline by default (images preview in the card); `download=1` marks the
 * response as an attachment so the browser's own download machinery saves it.
 * The bytes come from the user's workspace directory, the same file the agent's
 * tools read, so a path an agent printed here resolves to what it printed.
 *
 * A download is streamed rather than read: the shared-file ceiling in
 * `readWorkspaceFile` is what a chat channel can deliver, and it has no business
 * refusing a file the browser can save by itself.
 */
export async function GET(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const searchParams = request.nextUrl.searchParams;
  const fileParam = searchParams.get("file");

  if (!fileParam) {
    return new NextResponse("Missing 'file' query parameter", { status: 400 });
  }

  const userId = authResult.user.id;

  try {
    // `session` is the chat that shared the file: its worktree is where the
    // agent's relative paths point.
    const session = searchParams.get("session");
    const options = session ? { session } : {};

    if (searchParams.get("download") === "1") {
      const file = await resolveWorkspaceFile(userId, fileParam, options);
      return streamedFileResponse(request, {
        stream: await file.provider.openReadStream(file.path),
        name: file.fileName,
        mimeType: file.mimeType,
        size: file.size,
        modified: file.modified,
        download: true,
      });
    }

    const file = await readWorkspaceFile(userId, fileParam, options);
    return serveBuffer(request, file.buffer, file.mimeType);
  } catch (err) {
    if (err instanceof FileNotFoundError) {
      return new NextResponse("File not found", { status: 404 });
    }
    if (err instanceof FilePathEscapeError) {
      return new NextResponse("Access denied", { status: 403 });
    }
    throw err;
  }
}

/**
 * Serve bytes from a workspace file.
 *
 * A workspace file is mutable but its URL is not. the path is the whole
 * identity, so an agent that rewrites `report.pdf` produces the exact same
 * request the browser already has cached. The response is therefore keyed by
 * content (ETag) and must be revalidated (`no-cache`): without that, clicking
 * Download replays whatever bytes were fetched first, and the user gets the
 * pre-edit file no matter how many times they share the new one.
 */
function serveBuffer(
  request: NextRequest,
  buffer: Uint8Array<ArrayBuffer>,
  mimeType: string,
): NextResponse {
  const etag = contentEtag(buffer);
  if (matchesEtag(request.headers.get("if-none-match"), etag)) {
    return new NextResponse(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": "private, no-cache" },
    });
  }

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": mimeType,
      "Content-Length": String(buffer.length),
      "Cache-Control": "private, no-cache",
      ETag: etag,
    },
  });
}
