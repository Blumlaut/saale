import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import { Stats } from "fs";
import path from "path";
import { requireSession } from "@/lib/auth";
import * as terminal from "@/lib/terminal/client";

const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR ?? "./uploads");

/**
 * GET /api/chat/workspace-files?file=relative/path
 *
 * Serve a file from the authenticated user's workspace.
 * Used by the show_file tool's FileCard component for on-demand file delivery.
 *
 * When Open Terminal is configured, proxies through its API (files live in the container).
 * Otherwise reads from the local uploads directory.
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

  // When Open Terminal is configured, files live in the container
  if (terminal.isConfigured()) {
    return serveFromTerminal(userId, fileParam);
  }

  return serveFromLocal(userId, fileParam);
}

/** Serve file through Open Terminal API */
async function serveFromTerminal(userId: string, filePath: string) {
  const homeDir = terminal.getTerminalHomeDir(userId);
  const fullPath = path.resolve(homeDir, filePath);

  // Validate path stays within user home
  const normalizedBase = path.resolve(homeDir);
  if (!fullPath.startsWith(normalizedBase + path.sep) && fullPath !== normalizedBase) {
    return new NextResponse("Access denied", { status: 403 });
  }

  try {
    const result = await terminal.readFileBinary(fullPath, { userId });
    return new NextResponse(new Uint8Array(result.buffer), {
      headers: {
        "Content-Type": result.mimeType,
        "Content-Length": String(result.buffer.length),
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("404")) {
      return new NextResponse("File not found", { status: 404 });
    }
    throw err;
  }
}

/** Serve file from local uploads directory (fallback) */
async function serveFromLocal(userId: string, filePath: string) {
  const userDir = path.join(UPLOADS_DIR, userId);

  // Validate path stays within workspace
  const resolved = path.resolve(userDir, filePath);
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
  const fileName = path.basename(filePath);
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
      "Content-Length": String(buffer.length),
      "Cache-Control": "private, max-age=3600",
    },
  });
}
