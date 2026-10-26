import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { readAvatar } from "@/lib/profile/avatar";

/**
 * GET /api/profile/avatar/<userId>. The stored picture.
 *
 * Signed-in users only: a picture is not public on this instance, and the id in
 * the URL is the same one that appears in user lists. The browser may keep it
 * briefly; the `?v=` stamp on the URL is what makes a new picture show up.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { userId } = await params;

  try {
    const avatar = await readAvatar(userId);
    if (!avatar) return new NextResponse(null, { status: 404 });

    return new NextResponse(new Uint8Array(avatar.data), {
      headers: {
        "content-type": avatar.mimeType,
        "cache-control": "private, max-age=300",
      },
    });
  } catch (err) {
    console.error("Failed to read the avatar:", err);
    return NextResponse.json({ error: "Could not load that picture" }, { status: 500 });
  }
}
