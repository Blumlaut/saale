import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import fs from "fs/promises";
import path from "path";

const UPLOAD_DIR = path.join(process.cwd(), "uploads");

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

  // Sanitize filename
  const safeName = path.basename(file.name).replace(/[^a-zA-Z0-9._-]/g, "_");
  const userDir = path.join(UPLOAD_DIR, authResult.user.id);
  const filePath = path.join(userDir, safeName);

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
