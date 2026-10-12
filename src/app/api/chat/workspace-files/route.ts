import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import fs from "fs/promises";
import type { Stats } from "fs";
import path from "path";
import { createHash } from "crypto";
import { requireSession } from "@/lib/auth";
import { getUploadsDir } from "@/lib/uploads";
import * as terminal from "@/lib/terminal/client";

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
    return serveFromTerminal(request, userId, fileParam);
  }

  return serveFromLocal(request, userId, fileParam);
}

/** Serve file through Open Terminal API */
async function serveFromTerminal(request: NextRequest, userId: string, filePath: string) {
  const homeDir = terminal.getTerminalHomeDir(userId);
  const fullPath = path.resolve(homeDir, filePath);

  // Validate path stays within user home
  const normalizedBase = path.resolve(homeDir);
  if (!fullPath.startsWith(normalizedBase + path.sep) && fullPath !== normalizedBase) {
    return new NextResponse("Access denied", { status: 403 });
  }

  try {
    const result = await terminal.readFileBinary(fullPath, { userId });
    return serveBuffer(request, result.buffer, result.mimeType);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("404")) {
      return new NextResponse("File not found", { status: 404 });
    }
    throw err;
  }
}

/** Serve file from local uploads directory (fallback) */
async function serveFromLocal(request: NextRequest, userId: string, filePath: string) {
  const userDir = path.join(getUploadsDir(), userId);

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

  const buffer = await fs.readFile(resolved);
  return serveBuffer(request, buffer, mimeTypeFor(filePath));
}

/**
 * Serve bytes from a workspace file.
 *
 * A workspace file is mutable but its URL is not — the path is the whole
 * identity, so an agent that rewrites `report.pdf` produces the exact same
 * request the browser already has cached. The response is therefore keyed by
 * content (ETag) and must be revalidated (`no-cache`): without that, clicking
 * Download replays whatever bytes were fetched first, and the user gets the
 * pre-edit file no matter how many times they share the new one.
 */
function serveBuffer(request: NextRequest, buffer: Uint8Array<ArrayBuffer>, mimeType: string) {
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

/** A strong ETag over the file's bytes — the only stable identity it has. */
function contentEtag(buffer: Uint8Array<ArrayBuffer>): string {
  return `"${createHash("sha1").update(buffer).digest("hex")}"`;
}

/** `If-None-Match` may carry a list of tags and weak-tag prefixes. */
function matchesEtag(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch.split(",").some((candidate) => candidate.trim().replace(/^W\//, "") === etag);
}

/** MIME type guessed from an extension, matching the client's map. */
function mimeTypeFor(filePath: string): string {
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

  const fileName = path.basename(filePath).toLowerCase();
  const ext = path.extname(fileName);
  return MIME_TYPES[ext] ?? "application/octet-stream";
}
