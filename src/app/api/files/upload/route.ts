import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import fs from "fs/promises";
import path from "path";

const UPLOAD_DIR = path.resolve(process.env.UPLOADS_DIR ?? "./uploads");
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

/** Allowed MIME types for uploads. */
const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "application/pdf",
  "text/plain",
  "text/csv",
  "text/markdown",
  "text/html",
  "text/xml",
  "application/json",
  "application/zip",
]);

/**
 * POST /api/files/upload — Upload a file to user's workspace
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const formData = await request.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  // Validate file size
  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: `File too large (max ${MAX_FILE_SIZE / (1024 * 1024)} MB)` },
      { status: 413 },
    );
  }

  // Validate MIME type
  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    return NextResponse.json({ error: `File type ${file.type} is not allowed` }, { status: 415 });
  }

  // Sanitize filename
  const safeName = path.basename(file.name).replace(/[^a-zA-Z0-9._-]/g, "_");
  const userDir = path.join(UPLOAD_DIR, authResult.user.id);
  const filePath = path.join(userDir, safeName);

  // Prevent directory traversal (defense in depth — safeName should already be clean)
  if (!filePath.startsWith(userDir)) {
    return NextResponse.json({ error: "Invalid file path" }, { status: 400 });
  }

  // Ensure directory exists
  await fs.mkdir(userDir, { recursive: true });

  // Write file
  const buffer = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(filePath, buffer);

  const stats = await fs.stat(filePath);

  return NextResponse.json({
    ok: true,
    file: {
      name: safeName,
      path: `/${authResult.user.id}/${safeName}`,
      size: stats.size,
      mimeType: file.type,
    },
  });
}
