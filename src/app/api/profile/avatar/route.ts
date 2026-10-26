import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { removeAvatar, saveAvatar, validateAvatarUpload } from "@/lib/profile/avatar";

/**
 * The signed-in user's own picture.
 *
 * POST takes one `file` and answers with the URL it is served from; the caller
 * keeps that URL in state instead of reloading the session.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  let form: FormData;
  try {
    form = await request.formData();
  } catch (err) {
    console.error("Failed to read the avatar upload:", err);
    return NextResponse.json({ error: "Expected an image upload" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Expected an image upload" }, { status: 400 });
  }

  const problem = validateAvatarUpload(file);
  if (problem) {
    return NextResponse.json({ error: problem }, { status: 400 });
  }

  try {
    const image = await saveAvatar(authResult.user.id, Buffer.from(await file.arrayBuffer()));
    return NextResponse.json({ image });
  } catch (err) {
    console.error("Failed to store the avatar:", err);
    return NextResponse.json({ error: "Could not save that image" }, { status: 500 });
  }
}

/** DELETE removes the picture and the `user.image` URL with it. */
export async function DELETE() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  try {
    await removeAvatar(authResult.user.id);
    return NextResponse.json({ image: null });
  } catch (err) {
    console.error("Failed to remove the avatar:", err);
    return NextResponse.json({ error: "Could not remove the picture" }, { status: 500 });
  }
}
