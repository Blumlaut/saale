import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { requirePermission } from "@/lib/auth";
import {
  deleteConfiguredProvider,
  listConfiguredProviders,
  saveCustomEndpoint,
  saveCustomEndpointLimits,
} from "@/lib/providers/configured";

/**
 * GET /api/admin/providers. every provider Pi can talk to, and which of them
 * the global configuration has credentials for.
 */
export async function GET() {
  const authResult = await requirePermission("admin", "providers");
  if (!authResult.ok) return authResult.response;

  return NextResponse.json(await listConfiguredProviders({ userId: null }));
}

/**
 * POST /api/admin/providers. configure the *global* OpenAI-compatible endpoint.
 *
 * Every other provider is configured by signing in to it
 * (`POST /api/admin/providers/login`), because Pi owns how those providers
 * authenticate.
 */
export async function POST(request: NextRequest) {
  const authResult = await requirePermission("admin", "providers");
  if (!authResult.ok) return authResult.response;

  const outcome = await saveCustomEndpoint({ userId: null }, await request.json());
  return outcome.ok
    ? NextResponse.json(outcome.data)
    : NextResponse.json({ error: outcome.error }, { status: outcome.status });
}

/**
 * PATCH /api/admin/providers. Update the global endpoint's model defaults
 * without touching its API key (so the UI never has to re-submit a stored
 * credential).
 */
export async function PATCH(request: NextRequest) {
  const authResult = await requirePermission("admin", "providers");
  if (!authResult.ok) return authResult.response;

  const outcome = await saveCustomEndpointLimits({ userId: null }, await request.json());
  return outcome.ok
    ? NextResponse.json(outcome.data)
    : NextResponse.json({ error: outcome.error }, { status: outcome.status });
}

/** DELETE /api/admin/providers. remove the global provider's credentials. */
export async function DELETE(request: NextRequest) {
  const authResult = await requirePermission("admin", "providers");
  if (!authResult.ok) return authResult.response;

  const { searchParams } = new URL(request.url);
  const outcome = await deleteConfiguredProvider({ userId: null }, searchParams.get("provider"));
  return outcome.ok
    ? NextResponse.json(outcome.data)
    : NextResponse.json({ error: outcome.error }, { status: outcome.status });
}
