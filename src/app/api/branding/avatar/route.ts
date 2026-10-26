import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { readBrandingAvatar } from "@/lib/branding/avatar";
import { readAdminSettings } from "@/lib/settings/update";

/**
 * GET /api/branding/avatar. The uploaded agent avatar, or a 404 when the admin
 * has not set one and the built-in mark should be drawn instead.
 *
 * Public like the stylesheet: the mark appears on shared chats as well. The
 * stored file name is the `ETag`, and a new upload renames the file, so a
 * browser holding the old bytes revalidates into the new ones.
 */
export async function GET(request: NextRequest) {
  const settings = await readAdminSettings();
  const fileName = settings?.brandingAvatar ?? "";

  const headers = {
    "Cache-Control": "public, max-age=0, must-revalidate",
    ETag: `"avatar-${fileName || "none"}"`,
  };

  if (!fileName) return new NextResponse(null, { status: 404, headers });

  if (request.headers.get("if-none-match") === headers.ETag) {
    return new NextResponse(null, { status: 304, headers });
  }

  const image = await readBrandingAvatar(fileName);
  if (!image) return new NextResponse(null, { status: 404, headers });

  return new NextResponse(new Uint8Array(image), {
    headers: { ...headers, "Content-Type": "image/png" },
  });
}
