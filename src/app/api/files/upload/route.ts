import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { headers } from "next/headers";
import fs from "fs/promises";
import path from "path";

const UPLOAD_DIR = path.join(process.cwd(), "uploads");

/**
 * POST /api/files/upload — Upload a file to user's workspace
 */
export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await request.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  // Sanitize filename
  const safeName = path.basename(file.name).replace(/[^a-zA-Z0-9._-]/g, "_");
  const userDir = path.join(UPLOAD_DIR, session.user.id);
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
      path: `/${session.user.id}/${safeName}`,
      size: stats.size,
      mimeType: file.type,
    },
  });
}
