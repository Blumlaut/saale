import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import { Stats } from "fs";
import path from "path";
import { requireSession } from "@/lib/auth";

const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR ?? "./uploads");

/**
 * GET /api/chat/workspace-files?file=relative/path
 *
 * Serve a file from the authenticated user's workspace.
 * Used by the show_file tool's FileCard component for on-demand file delivery.
 */
export async function GET(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const searchParams = request.nextUrl.searchParams;
  const fileParam = searchParams.get("file");

  if (!fileParam) {
    return new NextResponse("Missing 'file' query parameter", { status: 400 });
  }

  const userDir = path.join(UPLOADS_DIR, authResult.user.id);

  // Validate path stays within workspace
  const resolved = path.resolve(userDir, fileParam);
  const normalizedBase = path.resolve(userDir);
  if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
    return new NextResponse("Access denied", { status: 403 });
  }

  // Check file exists
  let stats: Stats;
  try {
    stats = await fs.stat(resolved);
  } catch {
    return new NextResponse("File not found", { status: 404 });
  }

  if (!stats.isFile()) {
    return new NextResponse("Not a file", { status: 400 });
  }

  // Read and serve
  const buffer = await fs.readFile(resolved);
  const fileName = path.basename(fileParam);
  const ext = path.extname(fileName).toLowerCase();

  const MIME_TYPES: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".bmp": "image/bmp",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".json": "application/json",
    ".xml": "application/xml",
    ".html": "text/html",
    ".css": "text/css",
    ".js": "text/javascript",
    ".ts": "text/typescript",
    ".md": "text/markdown",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".zip": "application/zip",
    ".gz": "application/gzip",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
  };

  const mimeType = MIME_TYPES[ext] ?? "application/octet-stream";

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": mimeType,
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Content-Length": String(buffer.length),
      "Cache-Control": "private, max-age=3600",
    },
  });
}
