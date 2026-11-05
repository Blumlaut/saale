import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { readJsonBody } from "@/lib/api-body";
import {
  clearInstanceSso,
  getSsoStatus,
  instanceSsoPatchSchema,
  saveInstanceSso,
} from "@/lib/auth/sso";

/**
 * The instance's identity provider.
 *
 * Admin-scoped, and the client secret is never echoed back: a read reports
 * whether one is stored, which is what the form needs to show.
 */

export async function GET() {
  const authResult = await requirePermission("admin", "settings");
  if (!authResult.ok) return authResult.response;

  return NextResponse.json({ sso: await getSsoStatus() });
}

export async function PATCH(request: NextRequest) {
  const authResult = await requirePermission("admin", "settings");
  if (!authResult.ok) return authResult.response;

  const body = await readJsonBody(request, instanceSsoPatchSchema);
  if (!body.ok) return body.response;

  try {
    const sso = await saveInstanceSso(body.data, authResult.user.id);
    return NextResponse.json({ sso });
  } catch (err) {
    console.error("Failed to save the instance single sign-on settings:", err);
    const message = err instanceof Error ? err.message : "Could not save the sign-on settings";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE() {
  const authResult = await requirePermission("admin", "settings");
  if (!authResult.ok) return authResult.response;

  await clearInstanceSso();
  return NextResponse.json({ sso: await getSsoStatus() });
}
