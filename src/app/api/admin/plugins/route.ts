import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { applyAdminSettingsPatch, SettingsError } from "@/lib/settings/update";
import { invalidatePluginCache, listPlugins, pluginLogEntries } from "@/lib/pi/plugins";
import { normalizePluginStates } from "@/lib/settings/properties";

/**
 * GET /api/admin/plugins — the plugin directory, every plugin with its load
 * state, and the recent log.
 */
export async function GET() {
  const authResult = await requirePermission("admin", "plugins");
  if (!authResult.ok) return authResult.response;

  try {
    return NextResponse.json({ ...(await listPlugins()), log: pluginLogEntries() });
  } catch (err) {
    console.error("Failed to list global Pi plugins:", err);
    return NextResponse.json({ error: "Failed to read the plugin directory" }, { status: 500 });
  }
}

/** Read the request body's plugin switches, if it has any. */
function pluginStatesPatch(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const states: Record<string, { enabled: boolean }> = {};
  for (const [id, enabled] of Object.entries(value as Record<string, unknown>)) {
    if (typeof enabled !== "boolean") continue;
    states[id] = { enabled };
  }
  return { piPluginStates: normalizePluginStates(states) };
}

/**
 * PATCH /api/admin/plugins — save the directory, the master switch, or a
 * plugin's switch.
 *
 * Written through the settings registry, which validates the values, checks
 * that the caller is an admin and rebuilds every pooled session afterwards.
 */
export async function PATCH(request: NextRequest) {
  const authResult = await requirePermission("admin", "plugins");
  if (!authResult.ok) return authResult.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch (err) {
    console.error("Failed to parse plugin settings body:", err);
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Expected a settings object" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (typeof input.dir === "string") patch.piPluginsDir = input.dir;
  if (typeof input.enabled === "boolean") patch.piPluginsEnabled = input.enabled;
  const states = pluginStatesPatch(input.plugins);
  if (states) Object.assign(patch, states);

  try {
    await applyAdminSettingsPatch(authResult.user.id, patch);
  } catch (err) {
    if (err instanceof SettingsError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("Failed to save plugin settings:", err);
    return NextResponse.json({ error: "Failed to save plugin settings" }, { status: 500 });
  }

  invalidatePluginCache();
  try {
    return NextResponse.json({ ...(await listPlugins()), log: pluginLogEntries() });
  } catch (err) {
    console.error("Failed to list global Pi plugins after saving:", err);
    return NextResponse.json({ error: "Saved, but reading the plugins failed" }, { status: 500 });
  }
}
