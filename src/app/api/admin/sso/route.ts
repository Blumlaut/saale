import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { readJsonBody } from "@/lib/api-body";
import { createSsoProvider, listSsoProviders, ssoProviderCreateSchema } from "@/lib/auth/sso";

/**
 * The instance's identity providers.
 *
 * Admin-scoped, and a client secret is never echoed back: a read reports whether
 * one is stored, which is what the form needs to show.
 */

export async function GET() {
  const authResult = await requirePermission("admin", "settings");
  if (!authResult.ok) return authResult.response;

  return NextResponse.json({ providers: await listSsoProviders() });
}

export async function POST(request: NextRequest) {
  const authResult = await requirePermission("admin", "settings");
  if (!authResult.ok) return authResult.response;

  const body = await readJsonBody(request, ssoProviderCreateSchema);
  if (!body.ok) return body.response;

  try {
    const provider = await createSsoProvider(body.data, authResult.user.id);
    return NextResponse.json({ provider }, { status: 201 });
  } catch (err) {
    console.error("Failed to add the single sign-on provider:", err);
    const message = err instanceof Error ? err.message : "Could not add the provider";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
