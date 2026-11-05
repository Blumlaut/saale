import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { readJsonBody } from "@/lib/api-body";
import {
  listSsoProviders,
  removeSsoProvider,
  ssoProviderPatchSchema,
  updateSsoProvider,
} from "@/lib/auth/sso";

/**
 * One identity provider, addressed by its database id.
 *
 * The slug in its callback URL is generated once and never edited, so a save
 * here cannot break the redirect URI an admin registered at the provider.
 */

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requirePermission("admin", "settings");
  if (!authResult.ok) return authResult.response;

  const body = await readJsonBody(request, ssoProviderPatchSchema);
  if (!body.ok) return body.response;

  const { id } = await params;

  try {
    const provider = await updateSsoProvider(id, body.data, authResult.user.id);
    if (!provider) {
      return NextResponse.json({ error: "Provider not found" }, { status: 404 });
    }
    return NextResponse.json({ provider });
  } catch (err) {
    console.error("Failed to save the single sign-on provider:", err);
    const message = err instanceof Error ? err.message : "Could not save the provider";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requirePermission("admin", "settings");
  if (!authResult.ok) return authResult.response;

  const { id } = await params;
  await removeSsoProvider(id);
  return NextResponse.json({ providers: await listSsoProviders() });
}
