import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";
import {
  deleteConfiguredProvider,
  listConfiguredProviders,
  saveCustomEndpoint,
  saveCustomEndpointLimits,
} from "@/lib/providers/configured";

/**
 * GET /api/providers. every provider Pi can talk to, and what this user has
 * configured (their own credentials, and the global ones they inherit).
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  return NextResponse.json(await listConfiguredProviders({ userId: authResult.user.id }));
}

/**
 * POST /api/providers. add an OpenAI-compatible endpoint, or update one the user
 * already has (its provider id in the body).
 *
 * Every other provider is configured by signing in to it
 * (`POST /api/providers/login`), because Pi owns how those providers
 * authenticate: it decides which value to ask for, and how to resolve it.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const outcome = await saveCustomEndpoint({ userId: authResult.user.id }, await request.json());
  return outcome.ok
    ? NextResponse.json(outcome.data)
    : NextResponse.json({ error: outcome.error }, { status: outcome.status });
}

/**
 * PATCH /api/providers. Update the endpoint's model limits without touching its
 * API key (so the UI never has to re-submit a stored credential).
 */
export async function PATCH(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const outcome = await saveCustomEndpointLimits(
    { userId: authResult.user.id },
    await request.json(),
  );
  return outcome.ok
    ? NextResponse.json(outcome.data)
    : NextResponse.json({ error: outcome.error }, { status: outcome.status });
}

/**
 * DELETE /api/providers. Disconnect a provider.
 *
 * The row *is* the credential for a provider Pi authenticates (Saale's
 * credential store reads it), so removing it signs the provider out.
 */
export async function DELETE(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { searchParams } = new URL(request.url);
  const outcome = await deleteConfiguredProvider(
    { userId: authResult.user.id },
    searchParams.get("provider"),
  );
  return outcome.ok
    ? NextResponse.json(outcome.data)
    : NextResponse.json({ error: outcome.error }, { status: outcome.status });
}
