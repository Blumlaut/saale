import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { applyUserSettingsPatch, ensureUserSettings, SettingsError } from "@/lib/settings/update";
import { serializeUserSettings } from "@/lib/settings/user-view";

/**
 * GET /api/settings. Get user settings
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const settings = await ensureUserSettings(authResult.user.id);

  return NextResponse.json({ settings: await serializeUserSettings(settings) });
}

/**
 * PATCH /api/settings. Update user settings
 *
 * The body is a column-keyed patch. It is validated and written through the
 * settings registry (`applyUserSettingsPatch`), which is the only writer of
 * `AppSettings`. so a value cannot reach the row without passing the same
 * validation the agent's `settings_set` tool uses.
 */
export async function PATCH(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch (err) {
    console.error("Failed to parse settings update body:", err);
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Expected a settings object" }, { status: 400 });
  }

  try {
    const settings = await applyUserSettingsPatch(
      authResult.user.id,
      body as Record<string, unknown>,
    );
    return NextResponse.json({ settings: await serializeUserSettings(settings) });
  } catch (err) {
    if (err instanceof SettingsError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("Failed to update settings:", err);
    return NextResponse.json({ error: "Failed to update settings" }, { status: 500 });
  }
}
