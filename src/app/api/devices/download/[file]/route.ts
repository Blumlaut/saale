import fs from "fs/promises";
import path from "path";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { packagedAgent } from "@/lib/devices/download";

/**
 * GET /api/devices/download/:file. hand over the agent this instance packaged.
 *
 * A route rather than a file in `public/`: the browser gets a name to save it
 * under, and nothing outside the packaged agents can be asked for.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ file: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { file } = await params;
  const absolute = await packagedAgent(file);
  if (!absolute) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const bytes = await fs.readFile(absolute).catch((err: unknown) => {
    console.error(`Failed to read the packaged agent ${absolute}:`, err);
    return null;
  });
  if (!bytes) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${path.basename(file)}"`,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "no-store",
    },
  });
}
