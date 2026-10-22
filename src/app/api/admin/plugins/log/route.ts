import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { clearPluginLog } from "@/lib/pi/plugins";

/** DELETE /api/admin/plugins/log — empty the in-memory plugin log. */
export async function DELETE() {
  const authResult = await requirePermission("admin", "plugins");
  if (!authResult.ok) return authResult.response;

  clearPluginLog();
  return NextResponse.json({ ok: true });
}
