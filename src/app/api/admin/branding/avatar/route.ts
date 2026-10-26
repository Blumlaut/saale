import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import {
  removeBrandingAvatar,
  storeBrandingAvatar,
  validateAvatarUpload,
} from "@/lib/branding/avatar";
import { serializeAdminSettings } from "@/lib/settings/admin-view";
import { ensureAdminSettings, setSetting } from "@/lib/settings/update";

/** The stored name, replaced (and the old file removed) on every upload. */
async function replaceAvatar(actorUserId: string, fileName: string) {
  const previous = (await ensureAdminSettings()).brandingAvatar;
  const view = await setSetting(actorUserId, "admin.brandingAvatar", fileName);
  if (previous && previous !== fileName) {
    try {
      await removeBrandingAvatar(previous);
    } catch (err) {
      // The new avatar is live; a leftover file is only wasted disk.
      console.error("Failed to delete the previous agent avatar:", err);
    }
  }
  return view;
}

/**
 * POST /api/admin/branding/avatar. Upload the agent avatar.
 *
 * Multipart, one `file`. The image is square-cropped and re-encoded, so what is
 * stored is never the bytes that arrived.
 */
export async function POST(request: NextRequest) {
  const authResult = await requirePermission("admin", "settings");
  if (!authResult.ok) return authResult.response;

  let form: FormData;
  try {
    form = await request.formData();
  } catch (err) {
    console.error("Failed to parse the agent avatar upload:", err);
    return NextResponse.json({ error: "Expected a multipart upload" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No image in the request" }, { status: 400 });
  }

  const problem = validateAvatarUpload(file);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  try {
    const stored = await storeBrandingAvatar(Buffer.from(await file.arrayBuffer()));
    await replaceAvatar(authResult.user.id, stored);
  } catch (err) {
    console.error("Failed to store the agent avatar:", err);
    return NextResponse.json({ error: "Failed to store the image" }, { status: 500 });
  }

  return NextResponse.json({ settings: serializeAdminSettings(await ensureAdminSettings()) });
}

/** DELETE /api/admin/branding/avatar. Go back to the built-in mark. */
export async function DELETE() {
  const authResult = await requirePermission("admin", "settings");
  if (!authResult.ok) return authResult.response;

  try {
    await replaceAvatar(authResult.user.id, "");
  } catch (err) {
    console.error("Failed to clear the agent avatar:", err);
    return NextResponse.json({ error: "Failed to clear the avatar" }, { status: 500 });
  }

  return NextResponse.json({ settings: serializeAdminSettings(await ensureAdminSettings()) });
}
