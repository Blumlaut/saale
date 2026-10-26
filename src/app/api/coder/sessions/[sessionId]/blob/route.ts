import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { loadSessionBlob } from "@/lib/coder/blob";
import { GitError } from "@/lib/coder/git";
import { contentEtag, matchesEtag } from "@/lib/files/http";
import { fileErrorResponse } from "@/lib/files/request";
import { inlineSafeType } from "@/lib/files/mime";

/**
 * GET /api/coder/sessions/:id/blob?path=[&sha=]
 *
 * One file out of the chat's checkout as bytes, for the images a diff has no
 * text for. Without a sha it is the worktree's copy; with one, the copy that
 * commit holds.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { sessionId } = await context.params;
  const params = request.nextUrl.searchParams;
  const path = params.get("path");
  if (!path) return NextResponse.json({ error: "path is required" }, { status: 400 });

  try {
    const blob = await loadSessionBlob(authResult.user.id, sessionId, {
      path,
      sha: params.get("sha"),
    });
    if (blob === null) {
      return NextResponse.json({ error: "No worktree for this chat" }, { status: 404 });
    }
    if ("error" in blob) {
      return NextResponse.json({ error: blob.error }, { status: blob.status });
    }

    const etag = contentEtag(blob.buffer);
    const cacheControl = blob.immutable
      ? "private, max-age=31536000, immutable"
      : "private, no-cache";
    if (matchesEtag(request.headers.get("if-none-match"), etag)) {
      return new NextResponse(null, {
        status: 304,
        headers: { ETag: etag, "Cache-Control": cacheControl },
      });
    }

    return new NextResponse(blob.buffer, {
      headers: {
        "Content-Type": inlineSafeType(blob.mimeType),
        "Content-Length": String(blob.buffer.length),
        "Cache-Control": cacheControl,
        "X-Content-Type-Options": "nosniff",
        ETag: etag,
      },
    });
  } catch (err) {
    if (err instanceof GitError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    return fileErrorResponse(err, `GET /api/coder/sessions/${sessionId}/blob`);
  }
}
