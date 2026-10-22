import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { evictAllSessions } from "@/lib/pi/agent-pool";
import {
  installNpmPlugin,
  invalidatePluginCache,
  listPlugins,
  pluginLogEntries,
  removeNpmPlugin,
} from "@/lib/pi/plugins";

/** Read the request body's `spec` (POST) or `id` (DELETE). */
async function readBody(request: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch (err) {
    console.error("Failed to parse the plugin install body:", err);
    return null;
  }
}

/**
 * POST /api/admin/plugins/install — install an npm package as a plugin.
 *
 * The package lands in the plugin directory and loads into every session built
 * afterwards, so the pooled sessions are rebuilt on success.
 */
export async function POST(request: NextRequest) {
  const authResult = await requirePermission("admin", "plugins");
  if (!authResult.ok) return authResult.response;

  const body = await readBody(request);
  const spec = typeof body?.spec === "string" ? body.spec : "";
  if (!spec.trim()) {
    return NextResponse.json({ error: "Enter an npm package" }, { status: 400 });
  }

  let installed;
  try {
    installed = await installNpmPlugin(spec);
  } catch (err) {
    // npm's own output is not fit for the page; the reason is in the log.
    console.error("Failed to install a plugin from npm:", err);
    const reason = err instanceof Error ? err.message : "Could not install the package";
    return NextResponse.json({ error: reason }, { status: 400 });
  }

  invalidatePluginCache();
  try {
    const evicted = await evictAllSessions();
    return NextResponse.json({
      ...(await listPlugins()),
      installed,
      evicted,
      log: pluginLogEntries(),
    });
  } catch (err) {
    console.error("Failed to read the plugins after installing:", err);
    return NextResponse.json(
      { error: "Installed, but reading the plugins failed" },
      { status: 500 },
    );
  }
}

/** DELETE /api/admin/plugins/install — remove an npm-installed plugin. */
export async function DELETE(request: NextRequest) {
  const authResult = await requirePermission("admin", "plugins");
  if (!authResult.ok) return authResult.response;

  const body = await readBody(request);
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id.trim()) {
    return NextResponse.json({ error: "Expected a plugin id" }, { status: 400 });
  }

  try {
    await removeNpmPlugin(id);
  } catch (err) {
    console.error("Failed to remove a plugin installed from npm:", err);
    const reason = err instanceof Error ? err.message : "Could not remove the package";
    return NextResponse.json({ error: reason }, { status: 400 });
  }

  invalidatePluginCache();
  try {
    const evicted = await evictAllSessions();
    return NextResponse.json({ ...(await listPlugins()), evicted, log: pluginLogEntries() });
  } catch (err) {
    console.error("Failed to read the plugins after removing one:", err);
    return NextResponse.json({ error: "Removed, but reading the plugins failed" }, { status: 500 });
  }
}
