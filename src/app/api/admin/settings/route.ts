import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { applyAdminSettingsPatch, ensureAdminSettings, SettingsError } from "@/lib/settings/update";
import { serializeAdminSettings } from "@/lib/settings/admin-view";

/**
 * GET /api/admin/settings. Get admin settings
 */
export async function GET() {
  const authResult = await requirePermission("admin", "settings");
  if (!authResult.ok) return authResult.response;

  const settings = await ensureAdminSettings();

  return NextResponse.json({ settings: serializeAdminSettings(settings) });
}

/**
 * PATCH /api/admin/settings. Update admin settings
 *
 * Written through the settings registry (`applyAdminSettingsPatch`), which is
 * the only writer of `AdminSettings` and re-checks that the caller is an admin.
 */
export async function PATCH(request: NextRequest) {
  const authResult = await requirePermission("admin", "settings");
  if (!authResult.ok) return authResult.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch (err) {
    console.error("Failed to parse admin settings update body:", err);
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Expected a settings object" }, { status: 400 });
  }

  try {
    const settings = await applyAdminSettingsPatch(
      authResult.user.id,
      body as Record<string, unknown>,
    );
    return NextResponse.json({ settings: serializeAdminSettings(settings) });
  } catch (err) {
    if (err instanceof SettingsError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("Failed to update admin settings:", err);
    return NextResponse.json({ error: "Failed to update admin settings" }, { status: 500 });
  }
}
