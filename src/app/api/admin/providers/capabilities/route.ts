import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { detectModelCapabilities, saveModelCapabilities } from "@/lib/providers/configured";

/**
 * PATCH /api/admin/providers/capabilities. Record what one model of a global
 * provider can do and how big its window is.
 *
 * Body: `{ provider, modelId, vision?, contextWindow?, maxOutputTokens? }`.
 */
export async function PATCH(request: NextRequest) {
  const authResult = await requirePermission("admin", "providers");
  if (!authResult.ok) return authResult.response;

  const outcome = await saveModelCapabilities({ userId: null }, await request.json());
  return outcome.ok
    ? NextResponse.json(outcome.data)
    : NextResponse.json({ error: outcome.error }, { status: outcome.status });
}

/**
 * POST /api/admin/providers/capabilities. Ask a global provider's endpoint what
 * its models can do and store the answers.
 */
export async function POST(request: NextRequest) {
  const authResult = await requirePermission("admin", "providers");
  if (!authResult.ok) return authResult.response;

  const outcome = await detectModelCapabilities({ userId: null }, await request.json());
  return outcome.ok
    ? NextResponse.json(outcome.data)
    : NextResponse.json({ error: outcome.error }, { status: outcome.status });
}
